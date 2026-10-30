import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState, expandIntegration } from './helpers';

/** 回归：连接卡保存后必须真的写进去（曾出现「保存未生效，请重试」）。 */
test('保存 OSS 卡后立即生效，不显示"保存未生效"', async ({ page }) => {
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
        prefix: ''
      }
    })
  );
  await page.goto('/#/settings/connections');
  await page.reload();
  await expect(page.getByTestId('settings-connections')).toBeVisible();
  await expandIntegration(page, 'oss');

  await page.locator('[data-field="oss.bucket"]').fill('saved-vault');
  await page.locator('[data-save="oss"]').click();

  await expect(page.locator('[data-integration="oss"]')).not.toContainText('保存未生效');
  await expect.poll(async () => (await readState(page)).obsidianConfig?.bucket).toBe('saved-vault');
  const saved: any = await readState(page);
  expect(saved.obsidianConnections[0].bucket).toBe('saved-vault');
});
