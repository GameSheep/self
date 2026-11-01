import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { seedState, baseState, STORAGE_KEY, gotoTab } from './helpers';

/**
 * Aliyun OSS V1 signature over fetch().
 * `Date` is a forbidden header name in the Fetch spec, so the browser drops it
 */

const KEY_ID = 'LTAI5tEXAMPLE000000000';
const KEY_SECRET = 'test-secret-not-a-real-key';
const BUCKET = 'self-hub';
const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>${BUCKET}</Name>
  <Prefix>vault/</Prefix>
  <MaxKeys>200</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>vault/signing-check.md</Key>
    <LastModified>2026-10-16T12:00:00.000Z</LastModified>
    <Size>42</Size>
  </Contents>
</ListBucketResult>`;

interface Captured {
  headers: Record<string, string>;
  url: string;
  method: string;
}

async function configureOss(page: any) {
  await seedState(
    page,
    baseState({
      obsidianConfig: {
        enabled: true,
        bucket: BUCKET,
        endpoint: ENDPOINT,
        region: 'oss-cn-beijing',
        accessKeyId: KEY_ID,
        accessKeySecret: KEY_SECRET,
        prefix: 'vault/'
      }
    })
  );
  await page.addInitScript(() => sessionStorage.clear());
  await page.goto('/');
  await gotoTab(page, '多平台数据互通');
  // 连接诊断默认折叠（summary 常显结论），点开后才能触发自检。
  await page.getByTestId('oss-diagnostics').locator('summary').click();
  await expect(page.getByTestId('oss-self-check')).toBeVisible();
}

test.describe('阿里云 OSS 签名', () => {
  test('用 x-oss-date 签名，且签名可被独立复算验证', async ({ page }) => {
    const captured: Captured[] = [];

    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      captured.push({
        headers: request.headers(),
        url: request.url(),
        method: request.method()
      });
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/xml',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'ETag,x-oss-request-id'
        },
        body: LIST_XML
      });
    });

    await configureOss(page);
    await page.locator('button', { hasText: '测连通' }).click();
    await expect(page.locator('main')).toContainText('直连验证成功', { timeout: 10_000 });

    expect(captured.length).toBeGreaterThan(0);
    const req = captured[0];
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    // The whole point: x-oss-date must be sent (Date cannot be).
    expect(headers['x-oss-date'], '必须发送 x-oss-date 头').toBeTruthy();
    expect(headers['authorization']).toMatch(new RegExp(`^OSS ${KEY_ID}:`));

    // Independently recompute the signature the service expects.
    const date = headers['x-oss-date'];
    const stringToSign = `GET\n\n\n${date}\nx-oss-date:${date}\n/${BUCKET}/`;
    const expected = createHmac('sha1', KEY_SECRET).update(stringToSign, 'utf8').digest('base64');
    expect(headers['authorization']).toBe(`OSS ${KEY_ID}:${expected}`);
  });

  test('拉取笔记列表时会解析 Contents 并带上正确的 prefix', async ({ page }) => {
    const urls: string[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      urls.push(request.url());
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: LIST_XML
      });
    });

    await configureOss(page);
    await page.locator('[data-testid="oss-refresh"]').click();
    await expect
      .poll(async () => {
        const raw = await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
        return raw ? (JSON.parse(raw).obsidianNotes || []).length : 0;
      })
      .toBe(1);

    const listUrl = urls.find((u) => u.includes('max-keys=1000'));
    expect(listUrl, '应发起列表请求').toBeTruthy();
    expect(listUrl).toContain('prefix=vault%2F');
  });

  test('OSS 失败时不谎报成功，而是给出真实错误', async ({ page }) => {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!request.url().includes(ENDPOINT)) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 403,
        headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' },
        body: `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Anonymous user has no right to access this bucket.</Message>
<RequestId>TEST-REQUEST-ID</RequestId></Error>`
      });
    });

    await configureOss(page);
    await page.locator('button', { hasText: '测连通' }).click();

    // The message must surface the OSS error code rather than a generic failure.
    await expect(page.locator('main')).toContainText('AccessDenied', { timeout: 10_000 });
    await expect(page.locator('main')).toContainText('TEST-REQUEST-ID');
    await expect(page.locator('main')).not.toContainText('直连验证成功');
  });
});
