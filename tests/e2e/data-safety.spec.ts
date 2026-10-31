import { test, expect } from '@playwright/test';
import { baseState, gotoTab, seedState, readState } from './helpers';

/**
 * 批次1（数据安全与闭环）回归：
 *
 * 这组用例守的是全仓的下限约定——不可逆删除必须有确认、未保存编辑必须被
 * 拦截、深链必须落地。每一条都对应审查报告里的一个 P0：
 * 1. NotesPane 切换笔记曾经直接 setSelectedId，编辑中的内容被静默覆盖；
 * 2. #/projects/:id 路由解析出来但 App 没有分支，搜索项目回车 = 整页空白；
 * 3. 域名删除曾是全站唯一零确认的破坏性操作（比删收件箱碎片防护还弱）；
 * 4. 批注详情页曾经只读——用户的原话契约是「只要修改删除，能够原始链接」。
 */

test.describe('数据安全下限', () => {
  test('笔记切换：脏内容先被拦截，放弃才切换，留在本页不动', async ({ page }) => {
    await seedState(
      page,
      baseState({
        notes: [
          { id: 'n1', title: '第一篇', content: '第一篇的正文', category: '速记', tags: [], updatedAt: Date.now() },
          { id: 'n2', title: '第二篇', content: '第二篇的正文', category: '速记', tags: [], updatedAt: Date.now() - 1000 }
        ]
      })
    );
    await gotoTab(page, '资料库');

    // 第一篇默认选中；开始编辑但不保存。
    await page.getByTestId('notes-textarea').fill('第一篇\n\n还没保存的修改内容');
    await expect(page.getByTestId('notes-status')).toContainText('未保存');

    await page.getByTestId('note-row-n2').getByRole('button').first().click();
    // 守卫弹出，且是应用内 ConfirmDialog（可断言、可键盘关闭），不是原生 confirm。
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // 留在本页：编辑中的文字原样还在，选中的还是第一篇。
    await dialog.getByRole('button', { name: '留在本页' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('notes-textarea')).toHaveValue(/还没保存的修改内容/);
    await expect(page.getByTestId('note-row-n1')).toHaveAttribute('data-selected', 'true');

    // 放弃修改：切换成功，目标笔记载入。
    await page.getByTestId('note-row-n2').getByRole('button').first().click();
    await dialog.getByRole('button', { name: '放弃修改' }).click();
    await expect(page.getByTestId('notes-textarea')).toHaveValue(/第二篇的正文/);
  });

  test('项目深链 #/projects/:id 直接渲染该项目，不再白屏', async ({ page }) => {
    await seedState(
      page,
      baseState({
        projects: [
          { id: 'p1', name: '深链项目', description: '深链正文', status: 'active', createdAt: Date.now(), updatedAt: Date.now() },
          { id: 'p2', name: '另一个项目', description: '', status: 'active', createdAt: Date.now(), updatedAt: Date.now() }
        ]
      })
    );
    // 直达深链（搜索命中 / 收件箱「打开目标」走的就是它）。
    await page.goto('/#/projects/p2');
    await expect(page.getByTestId('project-editor')).toBeVisible();
    await expect(page.getByTestId('project-name')).toHaveValue('另一个项目');
    await expect(page.getByTestId('project-text')).toHaveValue('');
  });

  test('新建项目：脏改动被拦下时不再建出空项目', async ({ page }) => {
    await seedState(
      page,
      baseState({
        projects: [{ id: 'p1', name: '已有项目', description: '', status: 'active', createdAt: Date.now(), updatedAt: Date.now() }]
      })
    );
    await gotoTab(page, '项目');
    await page.getByTestId('project-name').fill('改过的名字');
    await page.getByTestId('project-add').click();

    await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
    await expect(page.getByTestId('project-name')).toHaveValue('新项目');

    const projects = (await readState(page)).projects;
    expect(projects.map((p: { name: string }) => p.name).sort()).toEqual(['已有项目', '新项目']);
  });

  test('删除项目 / 删除域名都需要二次确认，首点不删', async ({ page }) => {
    await seedState(
      page,
      baseState({
        domains: [],
        projects: [{ id: 'p1', name: '要删的项目', description: '文本', status: 'active', createdAt: Date.now(), updatedAt: Date.now() }],
        domains: [
          {
            id: 'd1',
            name: 'example.com',
            registrar: 'Cloudflare',
            startAt: Date.now() - 300 * 86400000,
            expireAt: Date.now() + 65 * 86400000,
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ]
      })
    );
    await gotoTab(page, '项目');
    const del = page.getByTestId('project-delete');
    await del.click();
    await expect(del).toHaveAttribute('data-armed', 'true');
    expect((await readState(page)).projects).toHaveLength(1);
    await del.click();
    await expect.poll(async () => (await readState(page)).projects).toHaveLength(0);

    await gotoTab(page, '域名');
    const domDel = page.getByTestId('domain-delete-d1');
    await domDel.click();
    await expect(domDel).toHaveAttribute('data-armed', 'true');
    expect((await readState(page)).domains).toHaveLength(1);
    await domDel.click();
    await expect.poll(async () => (await readState(page)).domains).toHaveLength(0);
  });

  test('批注详情页能改能删，返回链接回到批注列表', async ({ page }) => {
    await seedState(
      page,
      baseState({
        annotations: [
          {
            id: 'a1',
            pageUrl: 'https://example.com/post',
            pageTitle: '示例文章',
            text: '划线原文内容',
            note: '原始批注',
            color: 'yellow',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ]
      })
    );
    await page.goto('/#/library/item/webpage:a1');
    await expect(page.getByTestId('library-item-webpage')).toBeVisible();

    // 编辑批注。
    await page.getByTestId('annotation-detail-edit').click();
    await page.getByTestId('annotation-detail-editor').locator('textarea').fill('修改后的批注');
    await page.getByTestId('annotation-detail-save').click();
    await expect(page.getByTestId('library-item-webpage')).toContainText('修改后的批注');
    const stored = (await readState(page)).annotations[0];
    expect(stored.note).toBe('修改后的批注');

    // 返回链接落在批注列表，而不是笔记编辑器。
    await page.getByRole('button', { name: '返回资料库' }).click();
    await expect(page.getByTestId('annotations-list')).toBeVisible();

    // 删除：二次确认后回到列表，条目消失（最后一条删掉后是空状态，不再是列表）。
    await page.goto('/#/library/item/webpage:a1');
    const del = page.getByTestId('annotation-detail-delete');
    await del.click();
    await expect(del).toHaveAttribute('data-armed', 'true');
    await del.click();
    await expect(page.getByTestId('annotations-pane')).toBeVisible();
    await expect(page.getByText('还没有网页批注')).toBeVisible();
    expect((await readState(page)).annotations).toHaveLength(0);
  });
});
