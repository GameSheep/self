import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState, expandIntegration } from './helpers';

/**
 * 多桶模型（按用户澄清）：
 * 1. **配置页**（设置 → 连接与任务）里，每个桶是**一张「阿里云 OSS」卡**，名字自定义；
 */
function bucket(overrides: Record<string, unknown>) {
  return {
    enabled: true,
    bucket: '',
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    region: '',
    accessKeyId: 'LTAI5tMULTI',
    accessKeySecret: 'secret',
    prefix: '',
    ...overrides
  };
}

const work = bucket({ id: 'oss-a', label: '工作库', bucket: 'work-vault' });
const personal = bucket({
  id: 'oss-b',
  label: '个人库',
  bucket: 'personal-vault',
  endpoint: 'oss-cn-beijing.aliyuncs.com',
  accessKeyId: 'LTAI5tPERSONAL'
});

test.describe('配置页：一个桶一张卡', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('两个桶显示为两张卡，名字与字段各自独立', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work, personal] }));
    await page.goto('/#/settings/connections');
    await page.reload();
    await expect(page.getByTestId('settings-connections')).toBeVisible();

    const first = page.locator('[data-integration="oss"]');
    const second = page.locator('[data-integration="oss:oss-b"]');
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await expect(first).toContainText('工作库');
    await expect(second).toContainText('个人库');

    await expandIntegration(page, 'oss');
    await expandIntegration(page, 'oss:oss-b');
    await expect(page.locator('[data-field="oss.bucket"]')).toHaveValue('work-vault');
    await expect(page.locator('[data-field="oss:oss-b.bucket"]')).toHaveValue('personal-vault');
    await expect(page.locator('[data-field="oss:oss-b.endpoint"]')).toHaveValue('oss-cn-beijing.aliyuncs.com');
  });

  test('改一个桶只影响那个桶', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work, personal] }));
    await page.goto('/#/settings/connections');
    await page.reload();
    await expect(page.getByTestId('settings-connections')).toBeVisible();
    await expandIntegration(page, 'oss:oss-b');

    await page.locator('[data-field="oss:oss-b.label"]').fill('个人库（新）');
    await page.locator('[data-field="oss:oss-b.bucket"]').fill('personal-vault-2');
    await page.locator('[data-save="oss:oss-b"]').click();

    await expect
      .poll(async () => {
        const saved: any = await readState(page);
        return saved.obsidianConnections?.find((c: any) => c.id === 'oss-b')?.bucket;
      })
      .toBe('personal-vault-2');
    const saved: any = await readState(page);
    expect(saved.obsidianConnections.find((c: any) => c.id === 'oss-b').label).toBe('个人库（新）');
    expect(saved.obsidianConnections.find((c: any) => c.id === 'oss-a').bucket).toBe('work-vault');
  });

  test('可以在配置页新增一个空白桶卡', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work] }));
    await page.goto('/#/settings/connections');
    await page.reload();
    await expect(page.getByTestId('settings-connections')).toBeVisible();

    await page.getByTestId('oss-card-add').click();
    await expect.poll(async () => (await readState(page)).obsidianConnections?.length).toBe(2);
    const saved: any = await readState(page);
    // A new bucket is configured but not yet shown in 远端笔记 — that is a separate choice.
    expect(saved.obsidianConnections[1].showInNotes).toBe(false);
  });

  test('每张桶卡都能删除（至少保留一个）', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work, personal] }));
    await page.goto('/#/settings/connections');
    await page.reload();
    await expect(page.getByTestId('settings-connections')).toBeVisible();

    // The second card has its own delete button.
    await expect(page.getByTestId('oss-card-remove-oss:oss-b')).toBeVisible();
    await page.getByTestId('oss-card-remove-oss:oss-b').click();
    await expect.poll(async () => (await readState(page)).obsidianConnections?.length).toBe(1);

    // With one bucket left there is no delete affordance: the last one cannot be removed.
    await expect(page.getByTestId('oss-card-remove-oss')).toHaveCount(0);
  });
});

test.describe('远端笔记：只显示选中的桶', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('已配置的桶按标签显示，切换标签切到对应桶', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work, personal] }));
    await page.goto('/#/library?view=sources');
    await page.reload();

    await expect(page.locator('[data-source-tab="obsidian"]')).toContainText('工作库');
    await expect(page.locator('[data-source-tab="obsidian-1"]')).toContainText('个人库');

    await page.locator('[data-source-tab="obsidian-1"]').click();
    await expect.poll(async () => (await readState(page)).obsidianConfig?.bucket).toBe('personal-vault');
  });

  test('「+ 桶」是从已配置的桶里挑，不新建空白桶', async ({ page }) => {
    const hidden = { ...personal, showInNotes: false };
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work, hidden] }));
    await page.goto('/#/library?view=sources');
    await page.reload();

    // Only the shown bucket has a tab.
    await expect(page.locator('[data-source-tab="obsidian"]')).toContainText('工作库');
    await expect(page.locator('[data-source-tab="obsidian-1"]')).toHaveCount(0);

    await page.getByTestId('obsidian-add-connection').click();
    const picker = page.getByTestId('obsidian-bucket-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('个人库');

    await page.getByTestId('obsidian-pick-oss-b').click();
    // It is now shown and active — and the connection count did not grow.
    await expect(page.locator('[data-source-tab="obsidian-1"]')).toContainText('个人库');
    const saved: any = await readState(page);
    expect(saved.obsidianConnections).toHaveLength(2);
    expect(saved.obsidianConfig.bucket).toBe('personal-vault');
  });

  test('可以把这个桶从远端笔记移除，但配置还在', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work, personal] }));
    await page.goto('/#/library?view=sources');
    await page.reload();
    await expect(page.locator('[data-source-tab="obsidian-1"]')).toContainText('个人库');

    await page.getByTestId('obsidian-hide-oss-b').click();

    // Tab gone, configuration untouched.
    await expect(page.locator('[data-source-tab="obsidian-1"]')).toHaveCount(0);
    const saved: any = await readState(page);
    expect(saved.obsidianConnections).toHaveLength(2);
    expect(saved.obsidianConnections.find((c: any) => c.id === 'oss-b').showInNotes).toBe(false);
    // It can be brought back through the picker.
    await page.getByTestId('obsidian-add-connection').click();
    await expect(page.getByTestId('obsidian-bucket-picker')).toContainText('个人库');
  });

  test('把仅有的桶也移除后，页面明说"配置还在"', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState({ obsidianConfig: work, obsidianConnections: [work, personal] }));
    await page.goto('/#/library?view=sources');
    await page.reload();

    await page.getByTestId('obsidian-hide-oss-a').click();
    await page.getByTestId('obsidian-hide-oss-b').click();

    await expect(page.getByTestId('no-shown-bucket')).toBeVisible();
    await expect(page.getByTestId('no-shown-bucket')).toContainText('配置还在');
    const saved: any = await readState(page);
    expect(saved.obsidianConnections).toHaveLength(2);
  });
});
