import { test, expect } from '@playwright/test';
import { seedState, baseState, readState, gotoTab } from './helpers';
import { RICH_MARKDOWN, RICH_NOTE_KEY } from './fixtures';

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';

async function seedForEdit(page: any, opts: { withOss?: boolean; content?: string } = {}) {
  await seedState(
    page,
    baseState({
      obsidianConfig: {
        enabled: Boolean(opts.withOss),
        bucket: 'example-obsidian-vault',
        endpoint: ENDPOINT,
        region: 'oss-cn-beijing',
        accessKeyId: opts.withOss ? 'LTAI5tEXAMPLE000000000' : '',
        accessKeySecret: opts.withOss ? 'test-secret' : '',
        prefix: ''
      },
      obsidianNotes: [
        {
          key: RICH_NOTE_KEY,
          title: '渲染测试',
          path: RICH_NOTE_KEY,
          size: 100,
          lastModified: 1760000000000,
          content: opts.content ?? RICH_MARKDOWN
        }
      ]
    })
  );
  await page.goto('/');
  await gotoTab(page, '多平台数据互通');
  await expect(page.locator('.md-body')).toBeVisible();
}

/** Enter editing mode from the reading view. */
async function enterEditMode(page: any) {
  await page.locator('button', { hasText: '编辑' }).first().click();
  await expect(page.locator('.md-editor-textarea')).toBeVisible();
}

const editorValue = (page: any) => page.locator('.md-editor-textarea').inputValue();

test.describe('Markdown 编辑器', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('三模式切换：编辑 / 分屏 / 预览', async ({ page }) => {
    await seedForEdit(page);
    await enterEditMode(page);

    // Edit mode: textarea only.
    await page.locator('.md-editor button', { hasText: '编辑' }).click();
    await expect(page.locator('.md-editor-textarea')).toBeVisible();
    await expect(page.locator('.md-editor-preview')).toHaveCount(0);

    // Split: both panes.
    await page.locator('.md-editor button', { hasText: '分屏' }).click();
    await expect(page.locator('.md-editor-textarea')).toBeVisible();
    await expect(page.locator('.md-editor-preview .md-body')).toBeVisible();
    await expect(page.locator('.md-editor-surface')).toHaveClass(/md-editor-split/);

    // Preview: no textarea.
    await page.locator('.md-editor button', { hasText: '预览' }).click();
    await expect(page.locator('.md-editor-textarea')).toHaveCount(0);
    await expect(page.locator('.md-editor-preview .md-h1')).toBeVisible();
  });

  test('工具栏粗体包裹选中文本', async ({ page }) => {
    await seedForEdit(page, { content: 'hello world' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(0, 5);
    });
    await page.locator('.md-editor button[title^="粗体"]').click();
    expect(await editorValue(page)).toBe('**hello** world');
  });

  test('Ctrl+B 快捷键加粗', async ({ page }) => {
    await seedForEdit(page, { content: 'hello world' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(6, 11);
    });
    await page.keyboard.press('Control+b');
    expect(await editorValue(page)).toBe('hello **world**');
  });

  test('工具栏标题按钮给行加前缀', async ({ page }) => {
    await seedForEdit(page, { content: '标题行' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').evaluate((el) => (el as HTMLTextAreaElement).focus());
    await page.locator('.md-editor button[title="二级标题"]').click();
    expect(await editorValue(page)).toBe('## 标题行');
  });

  test('Enter 自动延续任务列表', async ({ page }) => {
    await seedForEdit(page, { content: '- [ ] 第一项' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    await page.keyboard.press('Enter');
    expect(await editorValue(page)).toBe('- [ ] 第一项\n- [ ] ');
  });

  test('Enter 自动延续有序列表并递增序号', async ({ page }) => {
    await seedForEdit(page, { content: '1. 第一' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    await page.keyboard.press('Enter');
    expect(await editorValue(page)).toBe('1. 第一\n2. ');
  });

  test('Tab 插入缩进', async ({ page }) => {
    await seedForEdit(page, { content: 'abc' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(0, 0);
    });
    await page.keyboard.press('Tab');
    expect(await editorValue(page)).toBe('  abc');
  });

  test('编辑后状态栏显示未保存', async ({ page }) => {
    await seedForEdit(page, { content: 'abc' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').fill('abc 改了');
    await expect(page.locator('.md-editor-status')).toContainText('未保存');
  });

  test('分屏预览随输入实时更新', async ({ page }) => {
    await seedForEdit(page, { content: '# 旧标题' });
    await enterEditMode(page);
    await page.locator('.md-editor button', { hasText: '分屏' }).click();
    await page.locator('.md-editor-textarea').fill('# 新标题');
    await expect(page.locator('.md-editor-preview .md-h1')).toHaveText('新标题');
  });

  test('阅读视图勾选任务会改写源文本并标记未保存', async ({ page }) => {
    await seedForEdit(page, { content: '- [ ] 未完成项\n- [x] 已完成项\n' });
    const boxes = page.locator('.md-task-box');
    await expect(boxes).toHaveCount(2);
    await boxes.nth(0).check();

    const state = await readState(page);
    expect(state.obsidianNotes[0].content).toContain('- [x] 未完成项');
    // The change must be persisted locally and flagged as unsaved for OSS.
    await expect(page.locator('button', { hasText: '保存修改' })).toBeVisible();
  });

  test('Ctrl+S 触发保存并把正文 PUT 到 OSS', async ({ page }) => {
    const puts: string[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      if (request.method() === 'PUT') {
        puts.push(request.postData() || '');
        await route.fulfill({
          status: 200,
          headers: { 'Access-Control-Allow-Origin': '*', ETag: '"x"' },
          body: ''
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`
      });
    });

    await seedForEdit(page, { withOss: true, content: '原始内容' });
    await enterEditMode(page);
    await page.locator('.md-editor-textarea').fill('通过快捷键保存的内容');
    await page.locator('.md-editor-textarea').evaluate((el) => (el as HTMLTextAreaElement).focus());
    await page.keyboard.press('Control+s');

    await expect.poll(() => puts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(puts.join('\n')).toContain('通过快捷键保存的内容');
  });
});
