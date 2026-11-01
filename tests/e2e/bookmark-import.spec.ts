import { test, expect, Page } from '@playwright/test';
import { baseState, readState, seedState } from './helpers';

/**
 * P1-04 — 书签导入：先预览数量/重复/未知字段，再作为一整批导入，并且可以撤销。
 * The file below is a real Netscape-format export: a bookmark at the root, one
 * must be reported — and skipped — as a duplicate.
 */
const BOOKMARKS_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000">搜索</H3>
        <DL><p>
            <DT><A HREF="https://www.google.com/" ADD_DATE="1700000001">Google</A>
        </DL><p>
    <DT><H3 ADD_DATE="1700000002">工作</H3>
        <DL><p>
            <DT><A HREF="https://news.example.org/" ADD_DATE="1700000003">   </A>
            <DT><A HREF="https://docs.example.org/guide" ADD_DATE="1700000004">示例文档</A>
            <DT><A HREF="javascript:void(0)">脚本伪链接</A>
        </DL><p>
</DL><p>
`;

const EXISTING_SITE = {
  id: 'site-google',
  title: 'Google 搜索',
  url: 'https://www.google.com/',
  category: '搜索',
  visitCount: 5,
  createdAt: 1000,
  order: 0
};

async function seedLibrary(page: Page) {
  await seedState(
    page,
    baseState({ categories: ['全部', '搜索', '技术开发'], sites: [EXISTING_SITE] })
  );
}

/** The page heading lives in `#main`; the TopBar has a nav item with the same text. */
const pageHeading = (page: Page) => page.locator('#main').getByRole('heading', { name: '快捷导航' });

/** Open the navigation view and hand the bookmarks file to the import dialog. */
async function openImportWithFile(page: Page) {
  await page.goto('/#/navigation');
  await expect(pageHeading(page)).toBeVisible();

  await page.getByTestId('open-bookmark-import').click();
  await expect(page.getByTestId('bookmark-import-dialog')).toBeVisible();

  await page.getByTestId('bookmark-file-input').setInputFiles({
    name: 'bookmarks.html',
    mimeType: 'text/html',
    buffer: Buffer.from(BOOKMARKS_HTML, 'utf8')
  });
}

test.describe('书签导入：预览、跳过重复与撤销', () => {
  test('预览会数出总数、重复项和字段不完整项，并列出将创建的分组', async ({ page }) => {
    await seedLibrary(page);
    await openImportWithFile(page);

    const dialog = page.getByTestId('bookmark-import-dialog');

    // Three importable http(s) links; the javascript: href is reported separately.
    await expect(dialog.getByText('文件中的书签链接')).toBeVisible();
    const stats = dialog.locator('[data-tone]');
    await expect(stats.nth(0)).toHaveText('3'); // usable links found
    await expect(stats.nth(1)).toHaveText('2'); // will import
    await expect(stats.nth(2)).toHaveText('1'); // duplicates of already-saved URLs
    await expect(stats.nth(3)).toHaveText('1'); // unknown/missing fields
    await expect(dialog).toContainText('未导入的非 http 链接 1');

    // The duplicate row is marked, not silently dropped.
    await expect(dialog.getByText('重复，跳过')).toBeVisible();
    await expect(dialog.getByText('（无标题）')).toBeVisible();

    // Groups that will be created, and the fact an existing one is reused.
    const newGroups = dialog.getByTestId('preview-new-group');
    await expect(newGroups).toHaveCount(1);
    await expect(newGroups.first()).toHaveText('工作');
    await expect(dialog).toContainText('已存在的分组会直接复用：搜索');

    // Nothing has been written yet — the preview is a preview.
    await expect.poll(async () => (await readState(page)).sites.length).toBe(1);
  });

  test('默认跳过重复项，导入是一整批并且可以撤销（只删这一批）', async ({ page }) => {
    await seedLibrary(page);
    await openImportWithFile(page);

    const dialog = page.getByTestId('bookmark-import-dialog');
    // No site is overwritten: the checkbox to import copies is off by default.
    const copies = dialog.getByTestId('import-duplicates-as-copies');
    await expect(copies).toBeVisible();
    await expect(copies).not.toBeChecked();

    await dialog.getByTestId('bookmark-import-confirm').click();

    // Outcome is reported in the dialog, not with alert().
    const status = page.getByTestId('import-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('已导入 2 个');
    await expect(status).toContainText('跳过重复 1');

    const afterImport = await readState(page);
    expect(afterImport.sites.length).toBe(3);

    // The pre-existing site is untouched (not overwritten by the duplicate).
    const google = afterImport.sites.find((s: any) => s.id === 'site-google');
    expect(google).toBeTruthy();
    expect(google.visitCount).toBe(5);

    const imported = afterImport.sites.filter((s: any) => s.id !== 'site-google');
    expect(imported.length).toBe(2);
    const importedIds = imported.map((s: any) => s.id);

    // New groups exist and the imported records landed in the right ones.
    expect(afterImport.categories).toContain('工作');
    expect(imported.find((s: any) => s.url.includes('docs.example.org'))?.category).toBe('工作');
    // The blank-title bookmark is titled by its URL instead of being dropped.
    const untitled = imported.find((s: any) => s.url.includes('news.example.org'));
    expect(untitled?.title).toBe('https://news.example.org/');

    // Undo removes exactly this batch.
    await page.getByRole('button', { name: '撤销导入' }).click();
    await expect(page.getByText('已撤销，移除了 2 个本次导入的网站。')).toBeVisible();

    const afterUndo = await readState(page);
    expect(afterUndo.sites.length).toBe(1);
    expect(afterUndo.sites[0].id).toBe('site-google');
    expect(afterUndo.sites.some((s: any) => importedIds.includes(s.id))).toBe(false);
    expect(afterUndo.sites[0].visitCount).toBe(5);
  });

  test('勾选“存为副本”后重复链接会作为新记录导入，原记录不变', async ({ page }) => {
    await seedLibrary(page);
    await openImportWithFile(page);

    const dialog = page.getByTestId('bookmark-import-dialog');
    await dialog.getByTestId('import-duplicates-row').click();
    // The duplicate is no longer skipped: its row says "存为副本" and the count
    // above moves from 2 to 3.
    await expect(dialog.getByText('重复，存为副本')).toBeVisible();
    await expect(dialog.locator('[data-tone]').nth(1)).toHaveText('3');

    await dialog.getByTestId('bookmark-import-confirm').click();

    await expect(page.getByTestId('import-status')).toContainText('已导入 3 个');

    const state = await readState(page);
    expect(state.sites.length).toBe(4);
    const googleCopies = state.sites.filter((s: any) => s.url.includes('google.com'));
    expect(googleCopies.length).toBe(2);
    // The original record kept its identity and visit count.
    expect(state.sites.find((s: any) => s.id === 'site-google')?.visitCount).toBe(5);
  });

  test('重复导入同一个文件不会重复写入记录', async ({ page }) => {
    await seedLibrary(page);
    await openImportWithFile(page);

    const dialog = page.getByTestId('bookmark-import-dialog');
    await dialog.getByRole('button', { name: /导入 \d+ 个书签/ }).click();
    await expect(page.getByTestId('import-status')).toContainText('已导入 2 个');
    await expect.poll(async () => (await readState(page)).sites.length).toBe(3);

    // Re-importing the same file from the page must now find everything duplicated.
    await page.getByTestId('import-done').click();
    await expect(page.getByTestId('bookmark-import-dialog')).toHaveCount(0);

    await page.getByTestId('open-bookmark-import').click();
    await page.getByTestId('bookmark-file-input').setInputFiles({
      name: 'bookmarks.html',
      mimeType: 'text/html',
      buffer: Buffer.from(BOOKMARKS_HTML, 'utf8')
    });

    const secondRun = page.getByTestId('bookmark-import-dialog');
    await expect(secondRun.locator('[data-tone]').nth(1)).toHaveText('0');
    await expect(secondRun.getByTestId('bookmark-import-confirm')).toBeDisabled();
    await expect(secondRun.getByText('没有新书签可导入')).toBeVisible();

    await expect.poll(async () => (await readState(page)).sites.length).toBe(3);
  });
});
