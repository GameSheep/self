import { test, expect } from '@playwright/test';
import { seedState, baseState, readState, gotoSettingsPane, expandAllIntegrations } from './helpers';

/**
 * 设置中心的信息架构（P1-01 / P1-07）.
 * The rule: configuration lives in exactly one place. Before this, settings were spread across
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState(overrides);
}

test.describe('统一设置中心', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await seedState(page, state());
  });

  test('打开设置先看到概览，各项状态一目了然', async ({ page }) => {
    await page.goto('/');
    await gotoSettingsPane(page, 'overview');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.locator('[data-settings-nav="overview"]')).toHaveAttribute('data-active', 'true');
    // The overview pane itself is the landing section, not a blank shell.
    await expect(page.getByTestId('settings-page')).toContainText('设置');
  });

  test('七个分区都能打开，并且高亮当前分区', async ({ page }) => {
    const panes = ['overview', 'preferences', 'connections', 'storage', 'browser', 'privacy', 'maintenance'];
    for (const pane of panes) {
      await gotoSettingsPane(page, pane);
      await expect(page.locator(`[data-settings-nav="${pane}"]`)).toHaveAttribute('data-active', 'true');
    }
  });

  test('连接与任务：每个集成只渲染一份表单', async ({ page }) => {
    await gotoSettingsPane(page, 'connections');
    await expandAllIntegrations(page);
    // One card per integration — the old build had a second copy of some forms elsewhere.
    await expect(page.locator('[data-integration="oss"]')).toHaveCount(1);
    await expect(page.locator('[data-integration="webdav"]')).toHaveCount(1);
    await expect(page.locator('[data-integration="ai"]')).toHaveCount(1);
    // And the OSS/WebDAV inputs really are here (the user's question "where did my OSS go").
    await expect(page.locator('[data-field="oss.bucket"]')).toBeVisible();
    await expect(page.locator('[data-field="webdav.url"]')).toBeVisible();
  });

  test('备份与恢复的设置有唯一入口', async ({ page }) => {
    await gotoSettingsPane(page, 'storage');
    await expect(page.getByTestId('settings-storage')).toBeVisible();
    await expect(page.getByTestId('cloud-backup-section')).toBeVisible();

    // `#/settings/data` is a kept-working alias for 数据与备份: it renders the same
    // pane, not a second, divergent copy of the backup settings.
    await page.goto('/#/settings/data');
    await expect(page.getByTestId('settings-storage')).toBeVisible();
    await expect(page.getByTestId('cloud-backup-section')).toHaveCount(1);
  });

  test('集成卡片默认折叠，点「配置」才展开字段', async ({ page }) => {
    await gotoSettingsPane(page, 'connections');
    // The pane opens as a list of integrations, not a wall of forms.
    await expect(page.locator('[data-integration="oss"]')).toBeVisible();
    await expect(page.locator('[data-field="oss.bucket"]')).toHaveCount(0);
    await page.locator('[data-integration-toggle="oss"]').click();
    await expect(page.locator('[data-field="oss.bucket"]')).toBeVisible();
    await page.locator('[data-integration-toggle="oss"]').click();
    await expect(page.locator('[data-field="oss.bucket"]')).toHaveCount(0);
  });

  test('五彩 Token 只在设置里配置，保存后持久化（但不会因此启用连接）', async ({ page }) => {
    await seedState(page, state());
    await gotoSettingsPane(page, 'content');
    await expandAllIntegrations(page);
    const token = page.locator('[data-field="wucai.token"]');
    await token.fill('wucai-token-123');
    await page.locator('[data-save="wucai"]').click();
    await expect.poll(async () => (await readState(page)).wucaiConfig?.token).toBe('wucai-token-123');
    // Filling a token is not the same as switching the connection on.
    expect((await readState(page)).wucaiConfig?.enabled).toBe(false);
  });

  test('数据互通页不再有第二份五彩 Token 输入框', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/#/settings/content');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expandAllIntegrations(page);
    // Exactly one editor for the token, and it is the integration card.
    await expect(page.locator('[data-field="wucai.token"]')).toHaveCount(1);
    await page.goto('/#/library');
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('input[placeholder*="五彩"], input[placeholder*="Token"]')).toHaveCount(0);
  });
});
