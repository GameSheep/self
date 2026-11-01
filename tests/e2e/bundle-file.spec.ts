import { test, expect } from '@playwright/test';
import { resetApp, STORAGE_KEY, baseState } from './helpers';

/**
 * P2-06 / §9.1: single-file encrypted exchange between the web app and the
 * packaged extension.
 * moves as a file — and the UI must say that rather than imply shared storage. The
 */

const PASSWORD = 'bundle-password-123';
const LIBRARY = 'local-v2';

function sourceState(overrides: Record<string, unknown> = {}) {
  return baseState({
    sites: [
      { id: 's1', title: '网页版的站点', url: 'https://example.com', category: '默认', createdAt: 1 },
      { id: 's-new', title: '只有网页版有', url: 'https://new.example.com', category: '默认', createdAt: 2 }
    ],
    notes: [{ id: 'n1', title: '网页版的笔记', content: '# 正文', updatedAt: 5 }],
    handwritings: [],
    webdavConfig: {
      enabled: true,
      url: 'https://dav.example.com',
      username: 'web-user',
      // A credential the migration bundle must carry only when explicitly asked.
      password: 'WEBDAV-SECRET',
      pathPrefix: 'selfhub'
    },
    aiConfig: { provider: 'deepseek', apiKey: 'AI-SECRET', baseUrl: '', model: 'deepseek-chat' },
    backupPolicy: { provider: 'oss', enabled: false, format: 'legacy' },
    ...overrides
  });
}

function targetState(overrides: Record<string, unknown> = {}) {
  return baseState({
    sites: [{ id: 's1', title: '扩展版的站点', url: 'https://example.com', category: '默认', createdAt: 1 }],
    notes: [],
    handwritings: [],
    webdavConfig: { enabled: false, url: '', username: '', password: '', pathPrefix: '' },
    aiConfig: { provider: 'gemini', apiKey: '', baseUrl: '', model: '' },
    backupPolicy: { provider: 'oss', enabled: false, format: 'legacy' },
    ...overrides
  });
}

async function seed(page: any, state: unknown) {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [STORAGE_KEY, JSON.stringify(state)] as const
  );
  await page.goto('/#/settings/storage');
  await page.reload();
}

async function deviceId(page: any): Promise<string> {
  return page.evaluate(() => window.__selfhubContract!.backup.restore.deviceId());
}

async function buildBundle(page: any, options: { includeCredentials?: boolean; purpose?: 'backup' | 'migration' } = {}) {
  const device = await deviceId(page);
  return page.evaluate(
    ([password, libraryId, deviceId, includeCredentials]) =>
      window.__selfhubContract!.backup.bundle.build({
        password,
        libraryId,
        deviceId,
        includeCredentials,
        purpose: includeCredentials ? 'migration' : 'backup'
      }),
    [PASSWORD, LIBRARY, device, options.includeCredentials ?? false] as const
  );
}

async function previewBundle(page: any, json: string, password = PASSWORD) {
  return page.evaluate(
    ([bundle, pass, libraryId]) =>
      window.__selfhubContract!.backup.bundle.preview({ json: bundle, password: pass, libraryId }),
    [json, password, LIBRARY] as const
  );
}

test.describe('P2-06 单文件加密交换', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('导出的文件是加密包：结构正确、不含明文数据、也不含凭据', async ({ page }) => {
    await resetApp(page);
    await seed(page, sourceState());

    const built = await buildBundle(page);
    expect(built.ok, built.error).toBe(true);
    expect(built.fileName).toMatch(/^self-hub-bundle-.*\.json$/);

    const parsed = JSON.parse(built.json!);
    expect(parsed.format).toBe('selfhub-backup');
    expect(parsed.formatVersion).toBe(3);
    expect(parsed.mode).toBe('single-file');
    expect(parsed.completion.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(parsed.objects).length).toBeGreaterThan(0);

    // Nothing readable: not the record titles, not the secrets.
    expect(built.json).not.toContain('网页版的站点');
    expect(built.json).not.toContain('网页版的笔记');
    expect(built.json).not.toContain('WEBDAV-SECRET');
    expect(built.json).not.toContain('AI-SECRET');
  });

  test('在另一个环境导入：先预览差异，再按决策合并，数据与冲突都可控', async ({ page }) => {
    await resetApp(page);
    await seed(page, sourceState());
    const built = await buildBundle(page);
    expect(built.ok).toBe(true);

    // "Another environment": a different payload on the same browser profile.
    await seed(page, targetState());

    const previewed = await previewBundle(page, built.json!);
    expect(previewed.ok, JSON.stringify(previewed.error)).toBe(true);
    const preview = previewed.preview!;
    expect(preview.sameLibrary).toBe(true);
    expect(preview.packageCounts.sites).toBe(2);
    expect(preview.added.sites).toBe(1); // s-new
    expect(preview.conflictCounts.sites).toBe(1); // s1 differs
    expect(preview.credentialNote).toContain('已移除');

    const applied = await page.evaluate(
      (previewId) =>
        window.__selfhubContract!.backup.restore.apply({
          previewId,
          mode: 'merge',
          conflicts: { sites: 'use-backup' }
        }),
      preview.previewId
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;
    expect(state.sites.find((row: any) => row.id === 's1').title).toBe('网页版的站点');
    expect(state.sites.some((row: any) => row.id === 's-new')).toBe(true);
    expect(state.notes.some((row: any) => row.id === 'n1')).toBe(true);
  });

  test('密码错误与文件被改动都会被拒绝，且不写入任何东西', async ({ page }) => {
    await resetApp(page);
    await seed(page, sourceState());
    const built = await buildBundle(page);
    expect(built.ok).toBe(true);
    await seed(page, targetState());
    const before = await page.evaluate(() => JSON.stringify(window.__selfhubContract!.backup.restore.currentState()));

    const wrongPassword = await previewBundle(page, built.json!, 'not-the-password');
    expect(wrongPassword.ok).toBe(false);
    expect(wrongPassword.error?.code).toBe('AUTH_FAILED');

    // Flip one object's ciphertext: size stays plausible, hash no longer matches.
    const tampered = JSON.parse(built.json!);
    const firstPath = Object.keys(tampered.objects)[0];
    const envelope = JSON.parse(tampered.objects[firstPath]);
    tampered.objects[firstPath] = JSON.stringify({
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -8)}AAAAAAAA`
    });
    const tamperedPreview = await previewBundle(page, JSON.stringify(tampered));
    expect(tamperedPreview.ok).toBe(false);
    expect(tamperedPreview.error?.code).toBe('VALIDATION');
    expect(tamperedPreview.error?.userMessage).toContain('校验失败');

    // Also: a manifest hash mismatch (the completion marker's job remotely).
    const brokenCompletion = JSON.parse(built.json!);
    brokenCompletion.completion.manifestHash = 'deadbeef';
    const broken = await previewBundle(page, JSON.stringify(brokenCompletion));
    expect(broken.ok).toBe(false);
    expect(broken.error?.userMessage).toContain('完整性校验失败');

    const after = await page.evaluate(() => JSON.stringify(window.__selfhubContract!.backup.restore.currentState()));
    expect(after).toBe(before);
  });

  test('含凭据的文件必须显式要求；导入时凭据默认不导入', async ({ page }) => {
    await resetApp(page);
    await seed(page, sourceState());

    // Credentials without the migration purpose are refused outright.
    const device = await deviceId(page);
    const refused = await page.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.bundle.build({
          password,
          libraryId,
          deviceId,
          includeCredentials: true,
          purpose: 'backup'
        }),
      [PASSWORD, LIBRARY, device] as const
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('迁移用途');

    const withCredentials = await buildBundle(page, { includeCredentials: true, purpose: 'migration' });
    expect(withCredentials.ok, withCredentials.error).toBe(true);
    expect(withCredentials.fileName).toContain('migration');
    // Encrypted either way, even though it now carries secrets.
    expect(withCredentials.json).not.toContain('WEBDAV-SECRET');

    await seed(page, targetState());
    const previewed = await previewBundle(page, withCredentials.json!);
    expect(previewed.ok, JSON.stringify(previewed.error)).toBe(true);
    expect(previewed.preview!.includesCredentials).toBe(true);
    // The fixture configures WebDAV + AI, so those are what the scope must name.
    expect(previewed.preview!.credentialScope.join(' ')).toContain('WebDAV 密码');
    expect(previewed.preview!.credentialScope.join(' ')).toContain('AI API Key');

    // Default: restore the data, leave the connections alone.
    const applied = await page.evaluate(
      (previewId) =>
        window.__selfhubContract!.backup.restore.apply({ previewId, mode: 'merge', conflicts: {}, importCredentials: false }),
      previewed.preview!.previewId
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;
    expect(state.webdavConfig.password).toBe('');
    expect(state.aiConfig.apiKey).toBe('');
    expect(applied.report!.credentialsImported).toEqual([]);
    expect(state.sites.some((row: any) => row.id === 's-new')).toBe(true);
  });

  test('设置页可用：导出触发下载、选择文件后进入同一套预览', async ({ page }) => {
    await resetApp(page);
    await seed(page, targetState());

    await page.locator('[data-testid="v3-password-input"]').fill(PASSWORD);
    await page.locator('[data-testid="v3-unlock"]').click();
    await expect(page.locator('[data-testid="v3-bundle-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="v3-bundle-section"]')).toContainText('两个独立的库');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid="v3-export-bundle"]').click()
    ]);
    expect(download.suggestedFilename()).toMatch(/^self-hub-bundle-.*\.json$/);
    await expect(page.locator('[data-testid="v3-message"]')).toContainText('已生成加密文件');

    // Feed a file built from another payload back through the UI.
    const otherPage = await page.context().newPage();
    await otherPage.goto('/');
    await otherPage.evaluate(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [STORAGE_KEY, JSON.stringify(sourceState())] as const
    );
    await otherPage.reload();
    const otherDevice = await otherPage.evaluate(() => window.__selfhubContract!.backup.restore.deviceId());
    const built = await otherPage.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.bundle.build({ password, libraryId, deviceId }),
      [PASSWORD, LIBRARY, otherDevice] as const
    );
    await otherPage.close();
    expect(built.ok, built.error).toBe(true);

    await page.locator('[data-testid="v3-import-bundle-input"]').setInputFiles({
      name: 'bundle.json',
      mimeType: 'application/json',
      buffer: Buffer.from(built.json!, 'utf8')
    });
    const preview = page.locator('[data-testid="v3-restore-preview"]');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await expect(preview.locator('[data-preview-collection="sites"]')).toContainText('新增 1');
  });
});
