import { test, expect } from '@playwright/test';
import { seedState, baseState, readState, gotoSettingsPane, openSettings, expandAllIntegrations } from './helpers';

/**
 * AI 隐私：默认关闭、开启要显式确认、真实密钥不离开本机、无标签的随机串也按密钥处理。
 *
 * The rule these tests encode: the app never sends content anywhere by default, and when it
 * does, the key is masked first — the argument is about behaviour, not wording.
 */

/** Hosts the AI stack may call; route mocks only intercept these. */
const AI_HOSTS = ['generativelanguage.googleapis.com', 'api.deepseek.com'];

/** `state()` merges aiConfig fields (apiKey, model, provider, …). */
function state(aiOverrides: Record<string, unknown> = {}) {
  return baseState({
    aiConfig: {
      provider: 'gemini',
      apiKey: '',
      baseUrl: '',
      model: 'gemini-2.5-flash',
      cloudAiEnabled: false,
      ...aiOverrides
    }
  });
}

async function openAiPane(page: any) {
  await gotoSettingsPane(page, 'ai');
  await expandAllIntegrations(page);
}

/** The ingest dialog behind the top bar's 「智能整理」 action. */
async function openIngest(page: any) {
  await page.locator('button[title*="粘贴杂乱内容"]').click();
  await expect(page.locator('textarea').first()).toBeVisible();
}

test.describe('云端 AI 的默认边界', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('默认关闭：开启需要显式保存，并显示风险说明', async ({ page }) => {
    await seedState(page, state({ apiKey: 'k' }));
    await page.goto('/');
    await openAiPane(page);

    const toggle = page.locator('[data-field="ai.cloudAiEnabled"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('data-enabled', 'false');
    await expect(page.locator('[data-integration="ai"]')).toContainText('内容都不会离开这台设备');

    // Turning it on reveals the explicit risk statement.
    await toggle.click();
    await expect(page.locator('[data-warning="ai"]')).toContainText('API Key');

    // New contract (P1-08): the settings form is a draft. Toggling the switch no
    // longer writes state by itself — 「保存连接」 is what commits it. The assertion
    // below is unchanged: after the user's save, the switch must be persisted as on.
    await page.locator('[data-save="ai"]').click();
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
    await openSettings(page);
    await gotoSettingsPane(page, 'data');

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

test.describe('云端 AI 的密钥遮蔽', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  /** Capture the exact body sent to the AI provider. */
  async function captureAiRequest(page: any) {
    const bodies: string[] = [];
    await page.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (!AI_HOSTS.some((h) => url.includes(h))) return route.continue();
      bodies.push(req.postData() || '');
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      sites: [],
                      servers: [],
                      secrets: [
                        {
                          name: '示例密钥',
                          category: 'api_key',
                          rawValue: '⟪SH_MASKED_OpenAI密钥_0⟫',
                          description: '来自粘贴内容'
                        }
                      ],
                      notes: []
                    })
                  }
                ]
              }
            }
          ]
        })
      });
    });
    return bodies;
  }

  test('真实密钥不会出现在发往服务商的请求体里', async ({ page }) => {
    const bodies = await captureAiRequest(page);
    await seedState(
      page,
      state({
        provider: 'gemini',
        apiKey: 'AIza-provider-key',
        baseUrl: '',
        model: 'gemini-2.5-flash',
        cloudAiEnabled: true
      })
    );
    await page.goto('/');
    await openIngest(page);

    const REAL_KEY = 'sk-proj-REAL-SECRET-VALUE-1234567890';
    await page
      .locator('textarea')
      .fill(`备用密钥：${REAL_KEY}\n服务器 root 密码: SuperSecret123\nGitHub: ghp_abcdefghijklmnopqrstuvwxyz0123456789`);
    await page.locator('button', { hasText: '开始高精准识别' }).click();
    await page.waitForTimeout(3000);

    expect(bodies.length, '应确实调用了云端模型').toBeGreaterThan(0);
    const sent = bodies.join('\n');

    // The secrets must not be present anywhere in the request.
    expect(sent).not.toContain(REAL_KEY);
    expect(sent).not.toContain('SuperSecret123');
    expect(sent).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

    // The placeholders must be, so the model keeps the structure.
    expect(sent).toContain('SH_MASKED');

    // And the user is told what was removed.
    const report = page.getByTestId('mask-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText('已遮蔽');
    await expect(report).toContainText(/OpenAI密钥|令牌|密码/);
  });

  test('本地引擎用原文，不遮蔽（否则无法加密入库）', async ({ page }) => {
    const bodies = await captureAiRequest(page);
    await seedState(page, state({ provider: 'gemini', apiKey: 'k', baseUrl: '', model: 'm', cloudAiEnabled: false }));
    await page.goto('/');
    await openIngest(page);

    await page.locator('textarea').fill('API Key: sk-proj-LOCAL-ONLY-KEY-1234567890');
    await page.locator('button', { hasText: '开始高精准识别' }).click();
    await page.waitForTimeout(2500);

    expect(bodies, '本地引擎不应发起请求').toHaveLength(0);
    await expect(page.getByTestId('mask-report')).toHaveCount(0);
  });
});

test.describe('无标签裸 token 的熵值识别', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  async function capture(page: any) {
    const bodies: string[] = [];
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!AI_HOSTS.some((h) => req.url().includes(h))) return route.continue();
      bodies.push(req.postData() || '');
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ sites: [], servers: [], secrets: [], notes: [] }) }] } }]
        })
      });
    });
    return bodies;
  }

  test('没有任何标签的随机串也会被遮蔽', async ({ page }) => {
    const bodies = await capture(page);
    await seedState(
      page,
      state({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash', cloudAiEnabled: true })
    );
    await page.goto('/');
    await openIngest(page);

    const naked = 'a8Fk29dLq0Pz7Xc4Vb1Nm6Ts';
    await page.locator('textarea').fill(`这是我在某处记下的一串东西：${naked} 其余的记不清了`);
    await page.locator('button', { hasText: '开始高精准识别' }).click();
    await page.waitForTimeout(3000);

    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join('\n')).not.toContain(naked);
    const report = page.getByTestId('mask-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText('疑似令牌');
    // Cosmetic product bug (src/** untouched): `placeholderFor` strips non-\w
    // characters from the kind, so the entropy pass sends `⟪SH_MASKED__0⟫` with an
    // empty kind for 「疑似令牌」. The masking itself is correct — the raw token is
    // still absent from the request body and the report still names the kind — so
    // the assertions above stay as they are.
  });

  test('普通长句、网址与模型名不会被误伤', async ({ page }) => {
    const bodies = await capture(page);
    await seedState(
      page,
      state({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash', cloudAiEnabled: true })
    );
    await page.goto('/');
    await openIngest(page);

    const prose = 'ThisIsAnOrdinarySentenceWithoutDigitsThatShouldSurvive';
    const url = 'https://your-host.example.com/dav/selfhub_sync/state.json';
    const model = 'gemini-2.5-flash';
    await page.locator('textarea').fill(`${prose}\n${url}\n模型用的是 ${model}`);
    await page.locator('button', { hasText: '开始高精准识别' }).click();
    await page.waitForTimeout(3000);

    const sent = bodies.join('\n');
    expect(sent).toContain(prose);
    expect(sent).toContain(url);
    expect(sent).toContain(model);
    await expect(page.getByTestId('mask-report')).toHaveCount(0);
  });
});
