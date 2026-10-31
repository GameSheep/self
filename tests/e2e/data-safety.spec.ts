import { test, expect } from '@playwright/test';
import { baseState, gotoTab, seedState, readState } from './helpers';

/**
 * 数据安全下限回归：不可逆删除必须二次确认、未保存编辑必须被拦截、
 * 深链必须落地（每条对应审查报告里的一个 P0）。
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

    // 返回链接回到批注列表，而不是笔记编辑器。
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

  test('网站列表批量：多选移动/删除，删除同样要两击', async ({ page }) => {
    await seedState(
      page,
      baseState({
        categories: ['全部', '技术开发', '常用工具'],
        sites: [
          { id: 's1', title: '站点一', url: 'https://s1.example.com', category: '技术开发', visitCount: 1, createdAt: Date.now() },
          { id: 's2', title: '站点二', url: 'https://s2.example.com', category: '技术开发', visitCount: 1, createdAt: Date.now() },
          { id: 's3', title: '站点三', url: 'https://s3.example.com', category: '常用工具', visitCount: 1, createdAt: Date.now() }
        ]
      })
    );
    await gotoTab(page, '快捷导航');
    // 批量条只在列表视图；网格里没有多选。
    await page.getByRole('button', { name: '紧凑列表视图' }).click();

    await page.getByTestId('site-select-s1').check();
    await page.getByTestId('site-select-s2').check();
    const bar = page.getByTestId('site-batch-bar');
    await expect(bar).toContainText('已选 2 条');

    // 批量移动：两条一起进「常用工具」。
    await bar.getByLabel('移动到分组').selectOption('常用工具');
    const sites = (await readState(page)).sites;
    expect(sites.filter((s: { category: string }) => s.category === '常用工具')).toHaveLength(3);
    await expect(bar).toBeHidden();

    // 批量删除：首击武装不删，再击才删。
    await page.getByTestId('site-select-s1').check();
    await page.getByTestId('site-select-s2').check();
    const del = bar.getByRole('button', { name: '删除所选' });
    await del.click();
    await expect(del).toHaveAttribute('data-armed', 'true');
    expect((await readState(page)).sites).toHaveLength(3);
    await del.click();
    await expect.poll(async () => (await readState(page)).sites).toHaveLength(1);
  });
});
