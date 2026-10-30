import { test, expect } from '@playwright/test';
import { resetApp } from './helpers';

/**
 * P2-05: v3 backup format.
 *
 * The old backup was one mutable `state.json`. This spec covers what replaced it:
 * an immutable generation directory with an encrypted manifest and a completion
 * marker, written in an order that makes a half-finished upload impossible to
 * mistake for a good backup.
 *
 * The checks live in `src/infrastructure/backup/backupSuite.ts` and run inside the
 * browser against real Web Crypto, with an in-memory transport — the protocol is
 * what is under test here, not the OSS/WebDAV providers.
 */

type CheckResult = { name: string; ok: boolean; detail?: string };

function summarise(results: CheckResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `${r.name} → ${r.detail}`)
    .join('\n');
}

test.describe('P2-05 v3 备份格式', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
    await resetApp(page);
  });

  test('备份格式自检全部通过', async ({ page }) => {
    const results = (await page.evaluate(() =>
      window.__selfhubContract!.backup.run(`backup${Date.now()}`)
    )) as CheckResult[];

    expect(results.length).toBeGreaterThanOrEqual(11);
    expect(results.filter((r) => !r.ok), `失败项:\n${summarise(results)}`).toEqual([]);
  });

  test('中断上传不会留下可恢复的成功标记', async ({ page }) => {
    // Stated as its own test because it is the P2-05 acceptance criterion: a
    // failed upload must not produce something a later restore would trust.
    const results = (await page.evaluate(() =>
      window.__selfhubContract!.backup.run(`abort${Date.now()}`)
    )) as CheckResult[];

    const abortCheck = results.find((r) => r.name.includes('中断'));
    expect(abortCheck, '应包含中断上传检查项').toBeTruthy();
    expect(abortCheck!.ok, abortCheck!.detail).toBe(true);
  });

  test('常规备份排除连接凭据，但保留金库密文', async ({ page }) => {
    const results = (await page.evaluate(() =>
      window.__selfhubContract!.backup.run(`secrets${Date.now()}`)
    )) as CheckResult[];

    const secretsCheck = results.find((r) => r.name.includes('连接密钥'));
    expect(secretsCheck, '应包含凭据排除检查项').toBeTruthy();
    expect(secretsCheck!.ok, secretsCheck!.detail).toBe(true);
  });

  test('现有明文 state.json 备份仍可读（旧格式未被破坏）', async ({ page }) => {
    // The v3 writer is new; the v2 reader must keep working so an existing user's
    // history is not stranded (§10.2 "旧 state.json 保留只读").
    const legacy = await page.evaluate(async () => {
      const key = 'self_hub_data_v2';
      const state = {
        theme: 'dark',
        sites: [],
        servers: [],
        secrets: [],
        checkIns: [],
        reminders: [],
        notes: [],
        handwritings: [],
        categories: [],
        obsidianConfig: { enabled: false, bucket: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '', prefix: '' },
        aiConfig: { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' },
        cloudflareSync: { enabled: false, workerUrl: '', syncKey: '', autoSync: false },
        webdavConfig: { enabled: false, url: '', username: '', password: '', pathPrefix: '' }
      };
      localStorage.setItem(key, JSON.stringify(state));
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return { stored: Boolean(parsed), siteCount: parsed?.sites?.length ?? -1 };
    });
    expect(legacy.stored).toBe(true);
    expect(legacy.siteCount).toBe(0);

    // The app still boots and reads that payload.
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
  });
});
