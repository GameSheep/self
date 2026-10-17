import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * Privacy boundary for the AI ingest feature.
 *
 * "AI 智能分拣" is designed to extract API keys / SSH passwords from pasted
 * text — and that same text was being sent to a third-party model by default.
 * Cloud AI is now opt-in, and the UI must be explicit about the boundary.
 */

const AI_HOSTS = ['generativelanguage.googleapis.com', 'api.deepseek.com', 'api.openai.com', 'api.example.com'];

function state(aiConfig: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  return baseState({ aiConfig, ...extras });
}

/** Record every outbound request so we can prove nothing left the device. */
async function trackRequests(page: any) {
  const seen: string[] = [];
  page.on('request', (req: any) => {
    const url = req.url();
    if (AI_HOSTS.some((h) => url.includes(h))) seen.push(url);
  });
  return seen;
}

async function openIngest(page: any) {
  await page.locator('button', { hasText: 'AI 智能分拣' }).first().click();
  await expect(page.locator('textarea')).toBeVisible();
}

test.describe('AI 分拣的隐私边界', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('默认关闭云端 AI：有 Key 也不会发出请求', async ({ page }) => {
    const outbound = await trackRequests(page);
    await seedState(
      page,
      state({ provider: 'deepseek', apiKey: 'sk-real-key', baseUrl: '', model: 'deepseek-chat' })
    );
    await page.goto('/');
    await openIngest(page);

    await page.locator('textarea').fill('服务器 1.2.3.4 root 密码 abc123\nAPI Key: sk-should-not-leak');
    await page.locator('button', { hasText: '开始高精准识别' }).click();
    await page.waitForTimeout(2500);

    expect(outbound, '关闭云端 AI 时不得有任何外发请求').toHaveLength(0);
    // The local engine still did its job.
    await expect(page.locator('body')).toContainText(/服务器|凭证|笔记|网站/);
  });

  test('未开启云端时不显示外发警示，只说明本地引擎', async ({ page }) => {
    await seedState(page, state({ provider: 'deepseek', apiKey: 'sk-real-key', baseUrl: '', model: 'deepseek-chat' }));
    await page.goto('/');
    await openIngest(page);

    await expect(page.locator('body')).toContainText('内容不离开本机');
    await expect(page.getByTestId('cloud-ai-warning')).toHaveCount(0);
  });

  test('显式开启后才出现外发警示', async ({ page }) => {
    await seedState(
      page,
      state({ provider: 'deepseek', apiKey: 'sk-real-key', baseUrl: '', model: 'deepseek-chat', cloudAiEnabled: true })
    );
    await page.goto('/');
    await openIngest(page);

    const warning = page.getByTestId('cloud-ai-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('deepseek');
    await expect(warning).toContainText('API Key');
  });

  test('设置里的开关默认关闭，并说明风险', async ({ page }) => {
    await seedState(page, state({ provider: 'deepseek', apiKey: 'sk-real-key', baseUrl: '', model: 'deepseek-chat' }));
    await page.goto('/');
    await page.locator('aside button[title*="系统设置"]').click();
    await page.locator('[data-settings-nav="ai"]').click();

    const toggle = page.locator('[data-field="ai.cloudAiEnabled"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('data-enabled', 'false');
    await expect(page.locator('[data-integration="ai"]')).toContainText('内容都不会离开这台设备');

    // Turning it on reveals the explicit risk statement.
    await toggle.click();
    await expect(page.locator('[data-warning="ai"]')).toContainText('API Key');

    await expect.poll(async () => (await readState(page)).aiConfig?.cloudAiEnabled).toBe(true);
  });
});

test.describe('明文导出的风险提示', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('含凭据时导出明文会先确认，取消则不下发文件', async ({ page }) => {
    let downloads = 0;
    page.on('download', () => downloads++);

    await seedState(
      page,
      baseState({
        obsidianConfig: {
          enabled: true,
          bucket: 'b',
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          region: 'oss-cn-beijing',
          accessKeyId: 'id',
          accessKeySecret: 'SECRET-IN-FILE',
          prefix: ''
        }
      })
    );
    await page.goto('/');
    await page.locator('aside button[title*="系统设置"]').click();
    await page.locator('[data-settings-nav="data"]').click();

    // Dismiss the confirmation: no file may be produced.
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => d.dismiss());
    await page.locator('button', { hasText: '导出明文' }).click();
    await page.waitForTimeout(800);
    expect(downloads).toBe(0);

    // Accept it: the export proceeds.
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => d.accept());
    await page.locator('button', { hasText: '导出明文' }).click();
    await expect.poll(() => downloads, { timeout: 10_000 }).toBe(1);
  });
});
