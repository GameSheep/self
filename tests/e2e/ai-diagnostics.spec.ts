import { test, expect } from '@playwright/test';
import { seedState, baseState, gotoSettingsPane, expandAllIntegrations } from './helpers';

/**
 * AI 连接诊断.
 *
 * When a provider rejects a key or a model, the UI must show what the service actually said and
 * which model it used — not a generic "检测失败". These tests mock the hosts and assert on text.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState({
    aiConfig: {
      provider: 'gemini',
      apiKey: '',
      baseUrl: '',
      model: 'gemini-2.5-flash',
      cloudAiEnabled: false,
      ...overrides
    }
  });
}

async function openAiTab(page: any) {
  await gotoSettingsPane(page, 'ai');
  await expandAllIntegrations(page);
  await expect(page.getByTestId('ai-test')).toBeVisible();
}

/** Mock the provider host. */
async function mockProvider(page: any, status: number, body: unknown, onRequest?: (url: string, payload: string) => void) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (!url.includes('generativelanguage.googleapis.com') && !url.includes('api.deepseek.com')) {
      return route.continue();
    }
    onRequest?.(url, req.postData() || '');
    await route.fulfill({
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
  });
}

test.describe('AI 连接诊断', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('Key 无效（Gemini 返回 400）时显示服务商原文与修复建议', async ({ page }) => {
    await mockProvider(page, 400, {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ reason: 'API_KEY_INVALID' }]
      }
    });
    await seedState(page, state({ apiKey: 'bad-key', model: 'gemini-2.5-flash' }));
    await page.goto('/');
    await openAiTab(page);

    await page.getByTestId('ai-test').click();
    const result = page.getByTestId('ai-test-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText('400');
    await expect(result).toContainText('API key not valid');
    await expect(result).toContainText('API Key 无效');
    await expect(result).toContainText('Generative Language API');
  });

  test('测试成功时报告所用模型与延迟', async ({ page }) => {
    await mockProvider(page, 200, { candidates: [{ content: { parts: [{ text: '好' }] } }] });
    await seedState(page, state({ apiKey: 'good', model: 'gemini-2.5-flash' }));
    await page.goto('/');
    await openAiTab(page);

    await page.getByTestId('ai-test').click();
    const result = page.getByTestId('ai-test-result');
    await expect(result).toContainText('连接正常');
    await expect(result).toContainText('gemini-2.5-flash');
  });

  test('模型名与服务商不匹配时自动替换并提示', async ({ page }) => {
    const seen: string[] = [];
    await mockProvider(page, 200, { candidates: [{ content: { parts: [{ text: '好' }] } }] }, (url) => seen.push(url));
    // Gemini provider but DeepSeek's model name left over from a switch.
    await seedState(page, state({ provider: 'gemini', apiKey: 'k', model: 'deepseek-chat' }));
    await page.goto('/');
    await openAiTab(page);

    await page.getByTestId('ai-test').click();
    await expect(page.getByTestId('ai-test-result')).toContainText('连接正常', { timeout: 20_000 });

    // The request must carry a Gemini model, never "deepseek-chat".
    expect(seen[0]).toContain('models/gemini-2.5-flash');
    expect(seen[0]).not.toContain('deepseek-chat');
    await expect(page.getByTestId('ai-test-result')).toContainText('模型名与服务商不匹配');
  });

  test('云端调用失败时界面上明确提示回退，而不是假装成功', async ({ page }) => {
    await mockProvider(page, 400, {
      error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] }
    });
    await seedState(
      page,
      state({ provider: 'gemini', apiKey: 'bad', model: 'gemini-2.5-flash', cloudAiEnabled: true })
    );
    await page.goto('/');
    // The old 「AI 智能分拣」 button is gone; the same modal is now the top bar's
    // 「整理内容」 global action (matched by its title so the responsive label does
    // not matter).
    await page.locator('header button[title*="整理入库"]').click();
    await expect(page.locator('textarea')).toBeVisible();

    await page.locator('textarea').fill('服务器 1.2.3.4 root 密码 abc123');
    await page.locator('button', { hasText: '开始高精准识别' }).click();

    const warning = page.getByTestId('ai-fallback-warning');
    await expect(warning).toBeVisible({ timeout: 20_000 });
    await expect(warning).toContainText('云端 AI 调用失败');
    await expect(warning).toContainText('API key not valid');
    // Product bug (copy only, src/** untouched): this warning still tells the user to
    // check 「系统设置 → AI 模型」, but settings is now a routed page and the AI card
    // lives in 设置 → 连接与任务. The fallback contract asserted above is correct and
    // must not be weakened for stale help text.
  });
});
