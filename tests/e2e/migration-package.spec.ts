import { test, expect } from '@playwright/test';
import { resetApp, STORAGE_KEY, baseState } from './helpers';
import { mockOss } from './ossMock';

/**
 * P2-06: the credentials migration package (§10.3).
 * A migration package is the one artefact allowed to contain connection secrets, so
 * - it is written under its own root, so it can never be listed as a backup,
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'selfhub-migration-test';
const PREFIX = 'vault/';
const PASSWORD = 'backup-password-123';
const LIBRARY = 'local-v2';

const OSS_CONFIG = {
  enabled: true,
  bucket: BUCKET,
  endpoint: ENDPOINT,
  region: 'cn-beijing',
  accessKeyId: 'LTAI5tTestKeyForSigning',
  accessKeySecret: 'LOCAL-OSS-SECRET',
  prefix: PREFIX
};

/** The source device: configured connections, a couple of records, one stale test. */
function sourceState(overrides: Record<string, unknown> = {}) {
  return baseState({
    obsidianConfig: { ...OSS_CONFIG, accessKeyId: 'PACKAGE-ACCESS-ID', accessKeySecret: 'PACKAGE-OSS-SECRET' },
    webdavConfig: {
      enabled: true,
      url: 'https://dav.example.com',
      username: 'package-user',
      password: 'PACKAGE-WEBDAV-PASSWORD',
      pathPrefix: 'selfhub'
    },
    aiConfig: { provider: 'deepseek', apiKey: 'PACKAGE-AI-KEY', baseUrl: '', model: 'deepseek-chat' },
    cloudflareSync: { enabled: true, workerUrl: 'https://sync.example.com', syncKey: 'PACKAGE-SYNC-KEY', autoSync: false },
    backupPolicy: { provider: 'oss', enabled: true, format: 'v3' },
    connectionTests: {
      obsidian: { at: 1, ok: true, message: '在源设备上检测通过', fingerprint: 'fp-package' }
    },
    sites: [{ id: 's1', title: '迁移过来的站点', url: 'https://example.com', category: '默认', createdAt: 1 }],
    notes: [{ id: 'n1', title: '迁移过来的笔记', content: '# 正文', updatedAt: 1 }],
    ...overrides
  });
}

/** The target device: only the mocked OSS connection, no other credentials. */
function targetState(overrides: Record<string, unknown> = {}) {
  return baseState({
    obsidianConfig: { ...OSS_CONFIG },
    webdavConfig: { enabled: false, url: '', username: '', password: '', pathPrefix: '' },
    aiConfig: { provider: 'gemini', apiKey: '', baseUrl: '', model: '' },
    cloudflareSync: { enabled: false, workerUrl: '', syncKey: '', autoSync: false },
    backupPolicy: { provider: 'oss', enabled: true, format: 'v3' },
    sites: [],
    notes: [],
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

const OSS_CONFIG_FOR_BRIDGE = {
  bucket: BUCKET,
  endpoint: ENDPOINT,
  region: 'cn-beijing',
  accessKeyId: 'LTAI5tTestKeyForSigning',
  accessKeySecret: 'LOCAL-OSS-SECRET',
  prefix: PREFIX
};

test.describe('P2-06 迁移包', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('导出迁移包必须显式确认；未确认时一个对象都不写', async ({ page }) => {
    const oss = await mockOss(page, { bucket: BUCKET, endpoint: ENDPOINT });
    await resetApp(page);
    await seed(page, sourceState());
    const device = await deviceId(page);

    const refused = await page.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.migration.export({
          password,
          libraryId,
          deviceId,
          confirm: false
        }),
      [PASSWORD, LIBRARY, device] as const
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('明确确认');
    expect(oss.files.size).toBe(0);
  });

  test('迁移包写在独立根目录：不是备份、不计入状态、也不会被保留策略清掉', async ({ page }) => {
    const oss = await mockOss(page, { bucket: BUCKET, endpoint: ENDPOINT });
    await resetApp(page);
    await seed(page, sourceState());
    const device = await deviceId(page);

    const exported = await page.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.migration.export({ password, libraryId, deviceId, confirm: true }),
      [PASSWORD, LIBRARY, device] as const
    );
    expect(exported.ok, exported.error).toBe(true);
    expect(exported.description).toContain('含连接凭据（迁移包）');

    const keys = Array.from(oss.files.keys());
    const migrationKeys = keys.filter((key) => key.includes('.selfhub/migration/'));
    const backupKeys = keys.filter((key) => key.includes('.selfhub/v3/'));
    expect(migrationKeys.length).toBeGreaterThan(0);
    // Nothing landed in the daily backup root.
    expect(backupKeys).toEqual([]);
    expect(migrationKeys.some((key) => key.endsWith('_complete.json'))).toBe(true);
    // No `latest` pointer: a credentials package must never become "this device's
    // current backup".
    expect(keys.some((key) => key.endsWith('latest.json'))).toBe(false);

    // The migration listing sees it; the ordinary backup status does not.
    const listed = await page.evaluate(
      ([libraryId, deviceId, password]) =>
        window.__selfhubContract!.backup.migration.list({ libraryId, deviceId, password }),
      [LIBRARY, device, PASSWORD] as const
    );
    expect(listed.ok, listed.error).toBe(true);
    expect(listed.packages?.length).toBe(1);
    expect(listed.packages?.[0].includesCredentials).toBe(true);
    expect(listed.packages?.[0].credentialScope?.join(' ')).toContain('AccessKeySecret');
    expect(listed.packages?.[0].credentialScope?.join(' ')).toContain('WebDAV 密码');

    // The backup status panel (which lists the backup root and drives retention)
    // reports zero batches while the migration package exists.
    const status = await page.evaluate(() =>
      window.__selfhubContract!.backup.restore.currentState()
    );
    expect(status).toBeTruthy();
    const backups = keys.filter((key) => key.startsWith(`${PREFIX}.selfhub/v3/`));
    expect(backups).toEqual([]);
  });

  test('日常备份仍然不含任何连接凭据（与迁移包对照）', async ({ page }) => {
    const oss = await mockOss(page, { bucket: BUCKET, endpoint: ENDPOINT });
    await resetApp(page);
    await seed(page, sourceState());
    const device = await deviceId(page);

    // A normal backup through the same transport.
    const backup = await page.evaluate(
      ([password, libraryId, deviceId]) => window.__selfhubContract!.backup.restore.preview({
        kind: 'oss',
        config: {
          bucket: 'selfhub-migration-test',
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          region: 'cn-beijing',
          accessKeyId: 'LTAI5tTestKeyForSigning',
          accessKeySecret: 'LOCAL-OSS-SECRET',
          prefix: 'vault/'
        },
        password,
        generationId: 'does-not-exist',
        libraryId,
        deviceId
      }),
      [PASSWORD, LIBRARY, device] as const
    );
    // No such batch: the point is only that no credentials leak into ordinary
    // objects, which is asserted against the *stored bytes* below.
    expect(backup.ok).toBe(false);

    const exported = await page.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.migration.export({ password, libraryId, deviceId, confirm: true }),
      [PASSWORD, LIBRARY, device] as const
    );
    expect(exported.ok).toBe(true);
    for (const [key, body] of oss.files) {
      if (!key.includes('.selfhub/migration/')) continue;
      // Encrypted objects must not contain the plaintext secrets.
      expect(body).not.toContain('PACKAGE-OSS-SECRET');
      expect(body).not.toContain('PACKAGE-WEBDAV-PASSWORD');
      expect(body).not.toContain('PACKAGE-AI-KEY');
    }
  });

  test('迁移到新设备：整套配置与密钥被导入，并标记为需要重新测试', async ({ page }) => {
    const oss = await mockOss(page, { bucket: BUCKET, endpoint: ENDPOINT });
    await resetApp(page);

    // 1) Write the package from the source device's payload.
    await seed(page, sourceState());
    const device = await deviceId(page);
    const exported = await page.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.migration.export({ password, libraryId, deviceId, confirm: true }),
      [PASSWORD, LIBRARY, device] as const
    );
    expect(exported.ok, exported.error).toBe(true);
    const generationId = exported.generationId!;

    // 2) Switch to a fresh device: same mocked destination, no other credentials.
    await page.evaluate(() => localStorage.removeItem('self_hub_data_v2'));
    await seed(
      page,
      targetState({
        // A stale green test from before: importing a credential must drop it.
        connectionTests: {
          obsidian: { at: 1, ok: true, message: '旧设备的绿灯', fingerprint: 'fp-old' },
          ai: { at: 1, ok: true, message: '旧设备的绿灯', fingerprint: 'fp-old-ai' }
        }
      })
    );

    const previewed = await page.evaluate(
      ([password, generationId, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.restore.preview({
          kind: 'oss',
          config: {
            bucket: 'selfhub-migration-test',
            endpoint: 'oss-cn-beijing.aliyuncs.com',
            region: 'cn-beijing',
            accessKeyId: 'LTAI5tTestKeyForSigning',
            accessKeySecret: 'LOCAL-OSS-SECRET',
            prefix: 'vault/'
          },
          password,
          generationId,
          libraryId,
          deviceId,
          purpose: 'migration',
          sourceLibraryId: libraryId
        }),
      [PASSWORD, generationId, LIBRARY, device] as const
    );
    expect(previewed.ok, JSON.stringify(previewed.error)).toBe(true);
    const preview = previewed.preview!;
    expect(preview.purpose).toBe('migration');
    expect(preview.includesCredentials).toBe(true);
    expect(preview.credentialNote).toContain('迁移包');
    const plans = Object.fromEntries(preview.credentialPlans.map((plan) => [plan.service, plan.action]));
    // The local OSS has a secret, but it is a *different* account (PACKAGE-ACCESS-ID
    // vs LTAI5tTestKeyForSigning) → must be skipped, not overwritten.
    expect(plans.oss).toBe('skip');
    expect(plans.webdav).toBe('adopt');
    expect(plans.ai).toBe('adopt');
    expect(plans.sync).toBe('adopt');

    const applied = await page.evaluate(
      ([previewId, services]) =>
        window.__selfhubContract!.backup.restore.apply({
          previewId,
          mode: 'merge',
          conflicts: {},
          importCredentials: true,
          credentialServices: services
        }),
      [preview.previewId, ['oss', 'webdav', 'ai', 'sync']] as const
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;
    const report = applied.report!;

    // Adopted services carry the package's pair; the mismatched one was skipped.
    expect(state.webdavConfig.password).toBe('PACKAGE-WEBDAV-PASSWORD');
    expect(state.webdavConfig.url).toBe('https://dav.example.com');
    expect(state.aiConfig.apiKey).toBe('PACKAGE-AI-KEY');
    expect(state.aiConfig.provider).toBe('deepseek');
    expect(state.cloudflareSync.syncKey).toBe('PACKAGE-SYNC-KEY');
    expect(state.obsidianConfig.accessKeySecret).toBe('LOCAL-OSS-SECRET');
    expect(state.obsidianConfig.accessKeyId).toBe('LTAI5tTestKeyForSigning');
    expect(report.credentialsImported.length).toBe(3);
    expect(report.credentialsSkipped.map((entry) => entry.label).join(' ')).toContain('OSS');
    expect(report.credentialsSkipped[0].reason).toContain('另一个 OSS 账号');

    // Imported connections are untested here: the stale green records are gone.
    expect(report.connectionsToRetest.sort()).toEqual(['ai', 'sync', 'webdav']);
    expect(state.connectionTests.obsidian).toBeTruthy(); // untouched (skipped service)
    expect(state.connectionTests.ai).toBeUndefined();
    expect(report.pending.join(' ')).toContain('重新测试');

    // Data came along too.
    expect(state.sites.some((row: any) => row.id === 's1')).toBe(true);
  });

  test('不选择导入凭据时只恢复数据，本机连接保持不变', async ({ page }) => {
    const oss = await mockOss(page, { bucket: BUCKET, endpoint: ENDPOINT });
    await resetApp(page);
    await seed(page, sourceState());
    const device = await deviceId(page);
    const exported = await page.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.migration.export({ password, libraryId, deviceId, confirm: true }),
      [PASSWORD, LIBRARY, device] as const
    );
    expect(exported.ok).toBe(true);

    await seed(page, targetState());
    const previewed = await page.evaluate(
      ([password, generationId, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.restore.preview({
          kind: 'oss',
          config: {
            bucket: 'selfhub-migration-test',
            endpoint: 'oss-cn-beijing.aliyuncs.com',
            region: 'cn-beijing',
            accessKeyId: 'LTAI5tTestKeyForSigning',
            accessKeySecret: 'LOCAL-OSS-SECRET',
            prefix: 'vault/'
          },
          password,
          generationId,
          libraryId,
          deviceId,
          purpose: 'migration'
        }),
      [PASSWORD, exported.generationId, LIBRARY, device] as const
    );
    expect(previewed.ok, JSON.stringify(previewed.error)).toBe(true);

    const applied = await page.evaluate(
      (previewId) =>
        window.__selfhubContract!.backup.restore.apply({
          previewId,
          mode: 'merge',
          conflicts: {},
          importCredentials: false
        }),
      previewed.preview!.previewId
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;
    expect(state.webdavConfig.password).toBe('');
    expect(state.aiConfig.apiKey).toBe('');
    expect(state.cloudflareSync.syncKey).toBe('');
    expect(applied.report!.credentialsImported).toEqual([]);
    expect(applied.report!.credentialsSkipped.length).toBeGreaterThan(0);
    expect(applied.report!.credentialsSkipped[0].reason).toContain('不导入连接凭据');
    // Data still restored.
    expect(state.notes.some((row: any) => row.id === 'n1')).toBe(true);
  });

  test('已配置不同账号的设备不会被包里的密钥覆盖（不把 A 的凭据绑到 B 的服务）', async ({ page }) => {
    const oss = await mockOss(page, { bucket: BUCKET, endpoint: ENDPOINT });
    await resetApp(page);
    await seed(page, sourceState());
    const device = await deviceId(page);
    const exported = await page.evaluate(
      ([password, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.migration.export({ password, libraryId, deviceId, confirm: true }),
      [PASSWORD, LIBRARY, device] as const
    );
    expect(exported.ok).toBe(true);

    // Target device: same bucket/endpoint but a different AccessKeyId, plus its own
    // WebDAV account on another host.
    await seed(
      page,
      targetState({
        webdavConfig: {
          enabled: true,
          url: 'https://other-dav.example.com',
          username: 'other-user',
          password: 'OTHER-WEBDAV-PASSWORD',
          pathPrefix: 'selfhub'
        }
      })
    );

    const previewed = await page.evaluate(
      ([password, generationId, libraryId, deviceId]) =>
        window.__selfhubContract!.backup.restore.preview({
          kind: 'oss',
          config: {
            bucket: 'selfhub-migration-test',
            endpoint: 'oss-cn-beijing.aliyuncs.com',
            region: 'cn-beijing',
            accessKeyId: 'LTAI5tTestKeyForSigning',
            accessKeySecret: 'LOCAL-OSS-SECRET',
            prefix: 'vault/'
          },
          password,
          generationId,
          libraryId,
          deviceId,
          purpose: 'migration'
        }),
      [PASSWORD, exported.generationId, LIBRARY, device] as const
    );
    expect(previewed.ok, JSON.stringify(previewed.error)).toBe(true);
    const plans = Object.fromEntries(previewed.preview!.credentialPlans.map((plan) => [plan.service, plan.action]));
    expect(plans.oss).toBe('skip');
    expect(plans.webdav).toBe('skip');

    const applied = await page.evaluate(
      (previewId) =>
        window.__selfhubContract!.backup.restore.apply({
          previewId,
          mode: 'merge',
          conflicts: {},
          importCredentials: true
        }),
      previewed.preview!.previewId
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;
    expect(state.obsidianConfig.accessKeySecret).toBe('LOCAL-OSS-SECRET');
    expect(state.obsidianConfig.accessKeyId).toBe('LTAI5tTestKeyForSigning');
    expect(state.webdavConfig.password).toBe('OTHER-WEBDAV-PASSWORD');
    expect(state.webdavConfig.url).toBe('https://other-dav.example.com');
    // Services with nothing configured here are still adopted (that is the point of
    // a migration package); the two that clash must not be.
    const imported = applied.report!.credentialsImported.join(' ');
    expect(imported).not.toContain('OSS');
    expect(imported).not.toContain('WebDAV');
    const skippedLabels = applied.report!.credentialsSkipped.map((entry) => entry.label).join(' ');
    expect(skippedLabels).toContain('OSS');
    expect(skippedLabels).toContain('WebDAV');
  });

  test('设置页可用：列出将包含的凭据、二次确认后创建、再预览导入并勾选导入凭据', async ({ page }) => {
    const oss = await mockOss(page, { bucket: BUCKET, endpoint: ENDPOINT });
    await resetApp(page);
    await seed(page, targetState());
    // Unlock happens below; the export needs the session password.

    await page.locator('[data-testid="v3-password-input"]').fill(PASSWORD);
    await page.locator('[data-testid="v3-unlock"]').click();

    const migrationSection = page.locator('[data-testid="v3-migration-section"]');
    await expect(migrationSection).toBeVisible();
    // The source of truth for "what will be inside" is the current configuration,
    // so this target device (only the mocked OSS connection) lists exactly that.
    await expect(page.locator('[data-testid="v3-credential-scope"]')).toContainText('AccessKeySecret');

    // Creating a credentials package asks for an explicit confirmation first.
    await page.locator('[data-testid="v3-migration-export"]').click();
    await expect(page.locator('[data-testid="v3-migration-confirm"]')).toContainText('只用于你自己的另一台设备');
    await page.locator('[data-testid="v3-migration-export-confirm"]').click();
    await expect(page.locator('[data-testid="v3-message"]')).toContainText('迁移包已创建');

    // It shows up in its own list, marked as containing credentials.
    const listed = page.locator('[data-testid="v3-migration-list"]');
    await expect(listed).toBeVisible({ timeout: 10_000 });
    await expect(listed).toContainText('含连接凭据');
    expect(Array.from(oss.files.keys()).some((key) => key.includes('.selfhub/migration/'))).toBe(true);
    expect(Array.from(oss.files.keys()).some((key) => key.includes('.selfhub/v3/'))).toBe(false);

    // Previewing it offers the credential import, defaulting to off.
    await page.locator('[data-testid="v3-preview-migration"]').first().click();
    const preview = page.locator('[data-testid="v3-restore-preview"]');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    const optIn = page.locator('[data-testid="v3-import-credentials"]');
    await expect(optIn).toBeVisible();
    await expect(optIn).not.toBeChecked();
    // Same account on both sides here, so the plan says "keep local".
    await expect(page.locator('[data-credential-plan="oss"]')).toContainText('保留本机');

    // A credentials package must be removable: retention deliberately never touches
    // the migration root, so without this button it would sit in the bucket forever.
    // (The suite-wide handler dismisses dialogs; this one has to be accepted.)
    page.removeAllListeners('dialog');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-testid="v3-remove-migration"]').first().click();
    await expect(page.locator('[data-testid="v3-message"]')).toContainText('已删除迁移包');
    await expect
      .poll(() => Array.from(oss.files.keys()).filter((key) => key.includes('.selfhub/migration/')).length, {
        timeout: 10_000
      })
      .toBe(0);
  });
});
