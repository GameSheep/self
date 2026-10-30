import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState, expandIntegration } from './helpers';

/**
 * 配置只出现在一个地方。
 *
 * 用户的原话：「远端笔记下面还显示一个 阿里云 OSS 连接 / Bucket / Endpoint / 保存……就这种问题非常的多」。
 * 所以这里守两件事：
 * 1. 远端笔记页**没有任何连接配置输入框**（只读与使用），页面上只有一句"去哪里配"。
 * 2. 设置 → 连接与任务 是唯一能改配置的地方，且改完远端笔记读到的是同一份。
 */
test.describe('配置只在一处', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('远端笔记页没有配置表单，只有一句"去设置里配"', async ({ page }) => {
    await resetApp(page);
    await seedState(
      page,
      baseState({
        obsidianConfig: {
          id: 'oss-a',
          label: '工作库',
          enabled: true,
          bucket: 'work-vault',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          region: '',
          accessKeyId: 'LTAI5tMULTI',
          accessKeySecret: 'secret',
          prefix: '',
          showInNotes: true
        }
      })
    );
    await page.goto('/#/library?view=sources');
    await page.reload();

    await expect(page.locator('main')).toContainText('远端笔记');
    await expect(page.locator('main')).toContainText('连接参数统一在');

    // No config inputs anywhere on this page — that duplication is what the user objected to.
    await expect(page.locator('[data-config-field]')).toHaveCount(0);
    await expect(page.locator('[data-field^="oss."]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="source-config-"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存' })).toHaveCount(0);
  });

  test('改配置只能在设置里，改完远端笔记用的是同一份', async ({ page }) => {
    await resetApp(page);
    await seedState(
      page,
      baseState({
        obsidianConfig: {
          id: 'oss-a',
          label: '工作库',
          enabled: true,
          bucket: 'work-vault',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          region: '',
          accessKeyId: 'LTAI5tMULTI',
          accessKeySecret: 'secret',
          prefix: '',
          showInNotes: true
        }
      })
    );
    await page.goto('/#/settings/connections');
    await page.reload();
    await expect(page.getByTestId('settings-connections')).toBeVisible();

    await expandIntegration(page, 'oss');
    await page.locator('[data-field="oss.bucket"]').fill('renamed-vault');
    await page.locator('[data-save="oss"]').click();
    await expect.poll(async () => (await readState(page)).obsidianConfig?.bucket).toBe('renamed-vault');

    // The notes page reads that same config — no second copy to keep in sync.
    await page.goto('/#/library?view=sources');
    await expect(page.locator('main')).toContainText('renamed-vault');
  });
});
