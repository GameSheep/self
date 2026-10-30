import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState, gotoTab } from './helpers';

/**
 * 笔记文件夹（1）：左侧树，支持多层（`a/b/c`），新建/删除文件夹，笔记可移动。
 *
 * 文件夹是 `/` 分隔的路径，不是第二个实体：移动一篇笔记只是改一个字符串，多层嵌套也自然成立。
 * 删除文件夹**不删笔记**——里面的笔记上移到父级。
 */
test.describe('笔记：多层文件夹树', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('新建多层文件夹，笔记存进去，树里按层级显示', async ({ page }) => {
    // No `seedState` here on purpose: its init script re-applies the fixture on every navigation,
    // which would silently undo the folder on reload and make this test pass for the wrong reason.
    await resetApp(page);
    await gotoTab(page, '深度知识文档');

    // a/b 两层，一次输入即可。
    await page.getByTestId('notes-new-folder-input').fill('工作/项目A');
    await page.getByTestId('notes-new-folder-add').click();
    await expect.poll(async () => (await readState(page)).noteFolders).toContain('工作/项目A');

    // 文件夹是"选中"状态，写一篇就会落在它下面。
    await page.getByTestId('notes-textarea').fill('项目笔记\n正文');
    await page.getByTestId('notes-save').click();

    await expect
      .poll(async () => (await readState(page)).notes?.find((n: any) => n.title === '项目笔记')?.folder)
      .toBe('工作/项目A');

    // 树里能看到两层节点。
    const tree = page.getByTestId('notes-folder-tree');
    await expect(tree).toContainText('工作');
    await expect(tree).toContainText('项目A');

    // Persisted: a real reload still shows the folder, and the note is inside it.
    await page.reload();
    await gotoTab(page, '深度知识文档');
    await expect(page.getByTestId('notes-folder-tree')).toContainText('项目A');
    await page.locator('[data-folder-path="工作/项目A"]').click();
    await expect(page.locator('[data-testid^="note-row-"]').first()).toContainText('项目笔记');
  });

  test('点文件夹只看这个文件夹（含子文件夹）的笔记', async ({ page }) => {
    await seedState(
      page,
      baseState({
        noteFolders: ['工作', '工作/项目A', '生活'],
        notes: [
          { id: 'n1', title: '项目文档', content: 'x', folder: '工作/项目A', updatedAt: 3 },
          { id: 'n2', title: '工作周报', content: 'y', folder: '工作', updatedAt: 2 },
          { id: 'n3', title: '购物清单', content: 'z', folder: '生活', updatedAt: 1 }
        ]
      })
    );
    await page.goto('/#/library?view=notes');
    await page.reload();

    await page.locator('[data-folder-path="工作"]').click();
    await expect(page.getByTestId('note-row-n1')).toBeVisible();
    await expect(page.getByTestId('note-row-n2')).toBeVisible();
    await expect(page.getByTestId('note-row-n3')).toHaveCount(0);

    await page.locator('[data-folder-path="生活"]').click();
    await expect(page.getByTestId('note-row-n3')).toBeVisible();
    await expect(page.getByTestId('note-row-n1')).toHaveCount(0);
  });

  test('把笔记移到另一个文件夹（不复制，只有一条）', async ({ page }) => {
    await seedState(
      page,
      baseState({
        noteFolders: ['工作', '生活'],
        notes: [{ id: 'n1', title: '随笔', content: 'x', folder: '工作', updatedAt: 1 }]
      })
    );
    await page.goto('/#/library?view=notes');
    await page.reload();
    await page.getByTestId('note-row-n1').getByRole('button').first().click();

    await page.getByTestId('notes-note-folder').selectOption('生活');
    await expect
      .poll(async () => (await readState(page)).notes?.find((n: any) => n.id === 'n1')?.folder)
      .toBe('生活');
    expect((await readState(page)).notes).toHaveLength(1);
  });

  test('删除文件夹不删笔记，笔记移回父级', async ({ page }) => {
    await seedState(
      page,
      baseState({
        noteFolders: ['工作', '工作/项目A'],
        notes: [{ id: 'n1', title: '重要文档', content: 'x', folder: '工作/项目A', updatedAt: 1 }]
      })
    );
    await page.goto('/#/library?view=notes');
    await page.reload();

    await page.locator('[data-folder-remove="工作/项目A"]').click();
    await expect.poll(async () => (await readState(page)).noteFolders).not.toContain('工作/项目A');
    const saved: any = await readState(page);
    expect(saved.notes).toHaveLength(1);
    expect(saved.notes[0].folder).toBe('工作');
  });
});
