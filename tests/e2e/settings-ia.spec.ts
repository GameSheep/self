import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * Configuration must live in exactly one place.
 *
 * Before this, settings were spread across a 4-tab modal plus inputs buried in
 * business views (五彩 token in the data page, index controls in the tree panel),
 * and the extension had a second, unrelated sync config page.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState(overrides);
}

async function openSettings(page: any) {
  await page.locator('aside button[title*="系统设置"]').click();
  await expect(page.getByText('系统与服务集成设置')).toBeVisible();
}

test.describe('统一设置中心', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('打开设置先看到概览，各项状态一目了然', async ({ page }) => {
    await seedState(
      page,
      state({
        obsidianConfig: {
          enabled: true,
          bucket: 'my-vault',
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          region: 'oss-cn-beijing',
          accessKeyId: 'LTAI-test',
          accessKeySecret: 'secret',
          prefix: 'vault/'
        }
      })
    );
    await page.goto('/');
    await openSettings(page);

    const overview = page.getByTestId('settings-overview');
    await expect(overview).toBeVisible();
    await expect(overview).toContainText('阿里云 OSS');
    await expect(overview).toContainText('WebDAV');
    await expect(overview).toContainText('五彩');
    await expect(overview).toContainText('AI 模型');
    // OSS is configured, so its row shows the bucket.
    await expect(page.locator('[data-overview-item="oss"]')).toContainText('my-vault');
  });

  test('六个分区都能打开', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSettings(page);

    for (const section of ['storage', 'sync', 'content', 'ai', 'data', 'overview']) {
      await page.locator(`[data-settings-nav="${section}"]`).click();
      await expect(page.locator(`[data-settings-nav="${section}"]`)).toHaveClass(/bg-zinc-800/);
    }
  });

  test('概览的「配置」按钮跳到对应分区', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSettings(page);

    await page.locator('[data-overview-item="webdav"] button', { hasText: '配置' }).click();
    await expect(page.locator('[data-integration="webdav"]')).toBeVisible();
  });

  test('五彩 Token 只在设置里配置，保存后持久化', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSettings(page);

    await page.locator('[data-settings-nav="content"]').click();
    await page.locator('[data-field="wucai.token"]').fill('wc_pat_test_token');
    await page.locator('[data-save="wucai"]').click();

    await expect.poll(async () => (await readState(page)).wucaiConfig?.token).toBe('wc_pat_test_token');
    const saved: any = await readState(page);
    expect(saved.wucaiConfig.enabled).toBe(true);
  });

  test('数据互通页不再有第二份五彩 Token 输入框', async ({ page }) => {
    await seedState(page, state({ wucaiConfig: { enabled: true, token: 'existing' } }));
    await page.goto('/');
    await page.locator('nav button', { hasText: '多平台数据互通' }).click();
    await page.waitForTimeout(800);

    // The old inline modal is replaced by a pointer to settings.
    const tokenInputs = await page.locator('input[placeholder="wc_pat_••••••••"]').count();
    expect(tokenInputs).toBe(0);
  });

  test('每个集成只渲染一份表单（防止新旧两套并存）', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSettings(page);

    for (const id of ['oss', 'webdav', 'ai', 'wucai', 'youdao']) {
      const section = id === 'oss' || id === 'webdav' ? 'storage' : id === 'ai' ? 'ai' : 'content';
      await page.locator(`[data-settings-nav="${section}"]`).click();
      await expect(page.locator(`[data-integration="${id}"]`)).toHaveCount(1);

      const fields = await page.locator(`[data-field^="${id}."]`).count();
      const expected = id === 'youdao' ? 2 : id === 'wucai' ? 1 : id === 'ai' ? 4 : id === 'webdav' ? 4 : 5;
      expect(fields, `${id} 字段数量`).toBe(expected);
    }

    // No leftover bespoke inputs outside the registry-driven cards.
    const allBespoke = await page.locator('input[placeholder="例如: my-obsidian-vault"]').count();
    expect(allBespoke).toBeLessThanOrEqual(1);
  });

  test('备份与恢复的设置有唯一入口', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSettings(page);

    await page.locator('[data-settings-nav="storage"]').click();
    await expect(page.locator('[data-integration="webdav"]')).toBeVisible();
    await expect(page.locator('[data-integration="webdav"]')).toBeVisible();
    await expect(page.getByTestId('cloud-backup-section')).toBeVisible();

    // Export/import lives under data, not duplicated under storage.
    await page.locator('[data-settings-nav="data"]').click();
    await expect(page.getByTestId('cloud-backup-section')).toHaveCount(0);
  });
});



