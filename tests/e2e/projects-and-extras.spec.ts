import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, gotoTab, readState } from './helpers';

/**
 * 项目 (4) and 服务器备注项 (6.1).
 *
 * Both were asked for in the same spirit: stop making the user navigate around to store a
 * fact. A project is a name plus one block of text; a server can carry arbitrary label/value
 * notes (SSH tunnels, panels, accounts), duplicates allowed.
 */
test.describe('项目 = 名字 + 一块文本', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('新建项目、直接写文本、保存后刷新仍在', async ({ page }) => {
    await resetApp(page);
    await gotoTab(page, '自研项目空间');

    await expect(page.getByTestId('projects-view')).toBeVisible();
    await page.getByTestId('project-add').click();
    await page.getByTestId('project-name').fill('改版计划');
    await page.getByTestId('project-text').fill('周一：信息架构\n周二：域名与凭据\n周三：复盘');
    await page.getByTestId('project-save').click();

    await expect
      .poll(async () => (await readState(page)).projects?.find((p: any) => p.name === '改版计划')?.description)
      .toContain('周三：复盘');

    await page.reload();
    await gotoTab(page, '自研项目空间');
    await expect(page.getByTestId('projects-view')).toContainText('改版计划');
    await expect(page.getByTestId('project-text')).toHaveValue(/周三：复盘/);
  });

  test('保存文字不会丢掉项目上原有的其它字段', async ({ page }) => {
    // `noteIds` / `repoUrl` are no longer edited here, but they must survive a save — the page
    // became simpler, the data did not disappear.
    await seedState(
      page,
      baseState({
        projects: [
          {
            id: 'p1',
            name: '老项目',
            description: '原文本',
            status: 'active',
            repoUrl: 'https://example.invalid/repo',
            noteIds: ['note-1'],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    );
    await page.goto('/#/projects');
    await page.getByTestId('project-text').fill('改写后的文本');
    await page.getByTestId('project-save').click();

    // Poll: the write is synchronous, but the click handler and the read can interleave.
    await expect
      .poll(async () => (await readState(page)).projects[0].description, { timeout: 5000 })
      .toBe('改写后的文本');
    const saved: any = await readState(page);
    expect(saved.projects[0].repoUrl).toBe('https://example.invalid/repo');
    expect(saved.projects[0].noteIds).toEqual(['note-1']);
  });

  test('删除项目只删项目本身', async ({ page }) => {
    await seedState(
      page,
      baseState({
        notes: [{ id: 'n1', title: '不该被删的笔记', content: '正文', category: '速记', updatedAt: 1 }],
        projects: [
          { id: 'p1', name: '要删的项目', description: '文本', status: 'active', createdAt: 1, updatedAt: 1 }
        ]
      })
    );
    await page.goto('/#/projects');
    await page.getByTestId('project-delete').click();
    await expect.poll(async () => (await readState(page)).projects?.length).toBe(0);
    expect((await readState(page)).notes).toHaveLength(1);
  });
});

test.describe('服务器备注项', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('可以记任意「名称 + 内容」，不会再限制只存 SSH', async ({ page }) => {
    await seedState(
      page,
      baseState({
        servers: [
          {
            id: 'srv-1',
            name: '生产主机',
            publicIp: '203.0.113.10',
            env: 'prod',
            sshUser: 'root',
            createdAt: 1
          }
        ]
      })
    );
    await page.goto('/#/resources/servers');

    await page.getByTestId('server-extra-add-srv-1').click();
    const form = page.getByTestId('server-extra-form-srv-1');
    await form.locator('input[name="label"]').fill('SSH 映射');
    await form.locator('input[name="value"]').fill('127.0.0.1:8080 → 10.0.0.2:80');
    await form.getByRole('button', { name: '添加' }).click();

    // Second entry, same server: repeats are allowed and useful.
    await form.locator('input[name="label"]').fill('面板');
    await form.locator('input[name="value"]').fill('https://203.0.113.10:8443');
    await form.getByRole('button', { name: '添加' }).click();

    await expect
      .poll(async () => (await readState(page)).servers[0].extras?.length)
      .toBe(2);
    const saved: any = await readState(page);
    expect(saved.servers[0].extras[0]).toMatchObject({ label: 'SSH 映射' });
    expect(saved.servers[0].extras[1]).toMatchObject({ label: '面板' });

    // Rendered on the card, and removable.
    await expect(page.getByTestId('server-extras-srv-1')).toContainText('SSH 映射');
    await form.getByRole('button', { name: /删除 SSH 映射/ }).click();
    await expect
      .poll(async () => (await readState(page)).servers[0].extras?.length)
      .toBe(1);
  });
});
