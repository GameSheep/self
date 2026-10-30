import { test, expect } from '@playwright/test';
import { resetApp, STORAGE_KEY } from './helpers';

/**
 * P2-06: restore from a v3 batch.
 *
 * The rules this spec pins down are the ones §10.4 exists for, and each of them is
 * a way a restore can quietly destroy data:
 *
 * - previewing must not change anything,
 * - an edit made after the preview must stop the restore instead of being overwritten,
 * - same-id conflicts are decided by the user, never by "last write wins",
 * - a package from another library gets remapped ids instead of merging by accident,
 * - connection secrets stripped from the package must not blank the local ones.
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'selfhub-restore-test';
const PREFIX = 'vault/';
const PASSWORD = 'backup-password-123';
const LIBRARY = 'local-v2';

interface Captured {
  method: string;
  path: string;
}

async function mockOss(page: any, captured: Captured[]) {
  const files = new Map<string, string>();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (!url.includes(ENDPOINT)) {
      await route.continue();
      return;
    }
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag,Last-Modified',
      'Content-Type': 'application/xml'
    };
    const decoded = decodeURIComponent(url);
    const afterBucket = decoded.split(`${BUCKET}.${ENDPOINT}/`)[1] ?? '';
    const path = afterBucket.split('?')[0];
    const query = afterBucket.includes('?') ? afterBucket.slice(afterBucket.indexOf('?') + 1) : '';
    const method = request.method();

    if (method === 'GET' && !path) {
      const prefix = new URLSearchParams(query).get('prefix') ?? '';
      const contents = Array.from(files.keys())
        .filter((key) => key.startsWith(prefix))
        .map(
          (key) =>
            `<Contents><Key>${key}</Key><Size>${files.get(key)!.length}</Size>` +
            `<LastModified>${new Date().toUTCString()}</LastModified><ETag>"e"</ETag></Contents>`
        )
        .join('');
      await route.fulfill({
        status: 200,
        headers: cors,
        body:
          '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
          `<Name>${BUCKET}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}` +
          '</ListBucketResult>'
      });
      return;
    }

    if (method === 'PUT') {
      captured.push({ method: 'PUT', path });
      files.set(path, request.postData() ?? '');
      await route.fulfill({ status: 200, headers: { ...cors, ETag: '"new"' }, body: '' });
      return;
    }

    if (method === 'DELETE') {
      captured.push({ method: 'DELETE', path });
      files.delete(path);
      await route.fulfill({ status: 204, headers: cors, body: '' });
      return;
    }

    if (method === 'HEAD') {
      const exists = files.has(path);
      await route.fulfill({
        status: exists ? 200 : 404,
        headers: exists ? { ...cors, 'Last-Modified': new Date().toUTCString(), ETag: '"e"' } : cors,
        body: ''
      });
      return;
    }

    captured.push({ method: 'GET', path });
    const stored = files.get(path);
    if (stored === undefined) {
      await route.fulfill({ status: 404, headers: cors, body: '' });
      return;
    }
    await route.fulfill({ status: 200, headers: cors, body: stored });
  });

  return files;
}

const OSS_CONFIG = {
  bucket: BUCKET,
  endpoint: ENDPOINT,
  region: 'cn-beijing',
  accessKeyId: 'LTAI5tTestKeyForSigning',
  accessKeySecret: 'test-secret',
  prefix: PREFIX
};

/** The package's library: what the backup believed, with a couple of conflicts. */
function packageState(overrides: Record<string, unknown> = {}) {
  return {
    theme: 'dark',
    categories: ['默认'],
    sites: [
      { id: 's1', title: '备份版站点', url: 'https://example.com', category: '默认', createdAt: 1 },
      { id: 's-new', title: '只有备份里有', url: 'https://new.example.com', category: '默认', createdAt: 2 }
    ],
    notes: [
      { id: 'n1', title: '备份版笔记', content: '# 备份正文', updatedAt: 5 },
      { id: 'n2', title: '备份独有的笔记', content: '# 只此一份', updatedAt: 6 }
    ],
    handwritings: [
      {
        id: 'hw1',
        title: '备份里的手绘',
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=',
        createdAt: 1
      },
      { id: 'hw-missing', title: '缺附件的手绘', dataUrl: '', createdAt: 2 }
    ],
    projects: [
      {
        id: 'p1',
        name: '备份版项目',
        description: '',
        status: 'active',
        noteIds: ['n1', 'n2'],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    servers: [],
    secrets: [
      {
        id: 'sec1',
        name: '备份里的金库条目',
        category: 'api_key',
        encryptedValue: 'CIPHERTEXT-FROM-BACKUP',
        iv: 'iv',
        salt: 'salt',
        maskedPreview: 'sk-••••0000',
        updatedAt: 1
      }
    ],
    checkIns: [],
    reminders: [],
    inbox: [],
    annotations: [],
    obsidianNotes: [
      { key: 'vault/未下载.md', title: '未下载', path: 'vault/未下载.md', size: 10, lastModified: 1 }
    ],
    obsidianConfig: {
      enabled: true,
      bucket: BUCKET,
      endpoint: ENDPOINT,
      region: 'cn-beijing',
      accessKeyId: 'ACCESS-ID-IN-PACKAGE',
      // Stripped by the snapshot builder; present here only to prove the local
      // value survives.
      accessKeySecret: 'SHOULD-NOT-SURVIVE',
      prefix: PREFIX
    },
    webdavConfig: { enabled: false, url: '', username: '', password: '', pathPrefix: '' },
    aiConfig: { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' },
    cloudflareSync: { enabled: false, workerUrl: '', syncKey: '', autoSync: false },
    // Both providers are configured in this fixture, and the shared resolver
    // prefers WebDAV when nothing is pinned (P1-09). The test drives OSS, so it
    // pins OSS — which is also what a real user would have to do.
    backupPolicy: { provider: 'oss', enabled: true, format: 'v3' },
    // A field this build does not model: the restore must report it, not lose it.
    futureField: { note: '来自更新版本' },
    sitesExtra: [{ id: 'x' }],
    ...overrides
  };
}

/** The library as it is on this device: one conflicting row, one local-only row. */
function localState(overrides: Record<string, unknown> = {}) {
  return {
    ...packageState(),
    sites: [
      { id: 's1', title: '本机版站点', url: 'https://example.com', category: '默认', createdAt: 1 },
      { id: 's-local', title: '只有本机有', url: 'https://local.example.com', category: '默认', createdAt: 3 }
    ],
    notes: [
      { id: 'n1', title: '本机版笔记', content: '# 本机正文', updatedAt: 9 },
      { id: 'n-local', title: '本机独有笔记', content: '# 本机', updatedAt: 4 }
    ],
    handwritings: [],
    projects: [
      {
        id: 'p1',
        name: '本机版项目',
        description: '',
        status: 'active',
        noteIds: ['n1'],
        createdAt: 1,
        updatedAt: 2
      }
    ],
    obsidianConfig: {
      ...(packageState().obsidianConfig as Record<string, unknown>),
      accessKeySecret: 'LOCAL-OSS-SECRET',
      accessKeyId: 'LOCAL-ACCESS-ID'
    },
    webdavConfig: {
      enabled: true,
      url: 'https://dav.example.com',
      username: 'local-user',
      password: 'LOCAL-WEBDAV-PASSWORD',
      pathPrefix: 'selfhub'
    },
    aiConfig: { provider: 'deepseek', apiKey: 'LOCAL-AI-KEY', baseUrl: '', model: '' },
    cloudflareSync: { enabled: true, workerUrl: 'https://sync.example.com', syncKey: 'LOCAL-SYNC-KEY', autoSync: false },
    ...overrides
  };
}

/** Seed the app's payload, the package, and mock the destination. */
async function setup(
  page: any,
  options: { packageLibraryId?: string; pkg?: unknown; local?: unknown; localViaInitScript?: boolean } = {}
) {
  const captured: Captured[] = [];
  await mockOss(page, captured);
  await resetApp(page);

  // A package is addressed by (libraryId, deviceId, generationId), and the settings
  // page looks for *this* device's batches. Seeding under a made-up device id would
  // produce a package the UI could never list — a test artefact, not a feature.
  const deviceId = await appDeviceId(page);
  expect(deviceId, '应用启动后应写入设备 ID').not.toBe('');

  const libraryId = options.packageLibraryId ?? LIBRARY;
  const seeded = await page.evaluate(
    async ([state, password, pkgLibrary, device, generationId]) => {
      window.__selfhubContract!.backup.restore.setCurrentState(state);
      return window.__selfhubContract!.backup.restore.seedBatch({
        kind: 'oss',
        config: {
          bucket: 'selfhub-restore-test',
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          region: 'cn-beijing',
          accessKeyId: 'LTAI5tTestKeyForSigning',
          accessKeySecret: 'test-secret',
          prefix: 'vault/'
        },
        state,
        password,
        libraryId: pkgLibrary,
        deviceId: device,
        generationId
      });
    },
    [(options.pkg ?? packageState()) as never, PASSWORD, libraryId, deviceId, 'gen-restore-1'] as const
  );
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);

  // Now make the local library what the app really holds.
  const local = options.local ?? localState();
  if (options.localViaInitScript) {
    // For tests that drive the *UI*: seed before the app boots. Writing the payload
    // into a running app races with the app's own persistence effect, and the app
    // then boots from whatever won — which showed up as "no connection configured".
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key as string, value as string);
      },
      [STORAGE_KEY, JSON.stringify(local)] as const
    );
  } else {
    await page.evaluate(
      (state) => window.__selfhubContract!.backup.restore.setCurrentState(state),
      local as never
    );
  }

  return { captured, deviceId };
}

async function appDeviceId(page: any): Promise<string> {
  // `getDeviceId()` is lazy (it creates and persists the id on first use), so the
  // id has to be asked for rather than read out of localStorage.
  return page.evaluate(() => window.__selfhubContract!.backup.restore.deviceId());
}

async function preview(page: any, overrides: { generationId?: string; libraryId?: string; sourceLibraryId?: string } = {}) {
  const device = await appDeviceId(page);
  return page.evaluate(
    ([password, generationId, libraryId, deviceId, sourceLibraryId]) =>
      window.__selfhubContract!.backup.restore.preview({
        kind: 'oss',
        config: {
          bucket: 'selfhub-restore-test',
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          region: 'cn-beijing',
          accessKeyId: 'LTAI5tTestKeyForSigning',
          accessKeySecret: 'test-secret',
          prefix: 'vault/'
        },
        password,
        generationId,
        libraryId,
        deviceId,
        sourceLibraryId
      }),
    [
      PASSWORD,
      overrides.generationId ?? 'gen-restore-1',
      overrides.libraryId ?? LIBRARY,
      device,
      overrides.sourceLibraryId
    ] as const
  );
}

test.describe('P2-06 v3 恢复', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('预览只读：给出两侧计数、冲突、缺失附件与要重新填写的东西', async ({ page }) => {
    await setup(page);
    const before = await page.evaluate(() => window.__selfhubContract!.backup.restore.currentState());

    const result = await preview(page);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const view = result.preview!;

    expect(view.packageCounts.sites).toBe(2);
    expect(view.localCounts.sites).toBe(2);
    expect(view.added.sites).toBe(1); // s-new
    expect(view.added.notes).toBe(1); // n2
    // s1, n1 and p1 differ; s-local / n-local exist only locally.
    expect(view.conflictCounts.sites).toBe(1);
    expect(view.conflictCounts.notes).toBe(1);
    expect(view.conflictCounts.projects).toBe(1);
    expect(view.conflicts.find((row) => row.collection === 'notes')?.label).toBe('备份版笔记');
    expect(view.referenceOnly.some((entry) => entry.includes('未下载'))).toBe(true);
    expect(view.credentialNote).toContain('不会用空值覆盖');
    expect(view.vaultNote).toContain('金库主密码');
    expect(view.unsupportedFields).toContain('根级字段 futureField');
    expect(view.unsupportedFields).toContain('根级字段 sitesExtra');

    // Nothing was written: the payload is byte-for-byte the same library.
    const after = await page.evaluate(() => window.__selfhubContract!.backup.restore.currentState());
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test('预览之后本机又有改动时拒绝恢复，而不是覆盖这些改动', async ({ page }) => {
    await setup(page);
    const result = await preview(page);
    expect(result.ok).toBe(true);

    // The user edits something after reading the preview.
    await page.evaluate(() => {
      const current = window.__selfhubContract!.backup.restore.currentState() as Record<string, unknown>;
      const notes = Array.isArray(current.notes) ? [...(current.notes as unknown[])] : [];
      notes.push({ id: 'n-after-preview', title: '预览之后写的', content: '# 新内容', updatedAt: 99 });
      window.__selfhubContract!.backup.restore.setCurrentState({ ...current, notes });
    });

    const applied = await page.evaluate(
      (previewId) =>
        window.__selfhubContract!.backup.restore.apply({ previewId, mode: 'merge', conflicts: {} }),
      result.preview!.previewId
    );
    expect(applied.ok).toBe(false);
    expect(applied.error?.code).toBe('REVISION_CONFLICT');
    expect(applied.error?.userMessage).toContain('重新预览');

    // And the edit is still there.
    const state = await page.evaluate(() => window.__selfhubContract!.backup.restore.currentState() as any);
    expect(state.notes.some((note: any) => note.id === 'n-after-preview')).toBe(true);
  });

  test('冲突逐集合决定：默认保留本机，可改用备份，也可另存副本并改写引用', async ({ page }) => {
    await setup(page);
    const previewed = await preview(page);
    const previewId = previewed.preview!.previewId;

    // Default: keep-local for every collection.
    const keepLocal = await page.evaluate(
      (id) => window.__selfhubContract!.backup.restore.apply({ previewId: id, mode: 'merge', conflicts: {} }),
      previewId
    );
    expect(keepLocal.ok, JSON.stringify(keepLocal.error)).toBe(true);
    const kept = keepLocal.state as any;
    expect(kept.sites.find((row: any) => row.id === 's1').title).toBe('本机版站点');
    expect(kept.sites.some((row: any) => row.id === 's-new')).toBe(true);
    expect(kept.notes.some((row: any) => row.id === 'n-local')).toBe(true);
    expect(keepLocal.report!.keptLocal).toBe(3);
    expect(keepLocal.report!.copies).toBe(0);

    // Fresh preview, then use-backup for notes only.
    await setup(page);
    const second = await preview(page);
    const useBackup = await page.evaluate(
      ([id]) =>
        window.__selfhubContract!.backup.restore.apply({
          previewId: id as string,
          mode: 'merge',
          conflicts: { notes: 'use-backup' }
        }),
      [second.preview!.previewId] as const
    );
    expect(useBackup.ok, JSON.stringify(useBackup.error)).toBe(true);
    const replaced = useBackup.state as any;
    expect(replaced.notes.find((row: any) => row.id === 'n1').title).toBe('备份版笔记');
    // Sites were not chosen, so they keep the local version.
    expect(replaced.sites.find((row: any) => row.id === 's1').title).toBe('本机版站点');

    // Fresh preview, then keep-both: the copy gets a new id and references follow.
    await setup(page);
    const third = await preview(page);
    const keepBoth = await page.evaluate(
      ([id]) =>
        window.__selfhubContract!.backup.restore.apply({
          previewId: id as string,
          mode: 'merge',
          conflicts: { sites: 'keep-both', notes: 'keep-both', projects: 'use-backup' }
        }),
      [third.preview!.previewId] as const
    );
    expect(keepBoth.ok, JSON.stringify(keepBoth.error)).toBe(true);
    const both = keepBoth.state as any;
    const original = both.sites.find((row: any) => row.id === 's1');
    const copy = both.sites.find((row: any) => row.id.startsWith('s1~restored-'));
    expect(original.title).toBe('本机版站点');
    expect(copy.title).toBe('备份版站点');
    expect(keepBoth.report!.copies).toBeGreaterThanOrEqual(2);

    // The copied note id must be what the (backup version of the) project points at.
    const noteCopy = both.notes.find((row: any) => row.id.startsWith('n1~restored-'));
    expect(noteCopy).toBeTruthy();
    const project = both.projects.find((row: any) => row.id === 'p1');
    expect(project.noteIds).toContain(noteCopy.id);
    expect(project.noteIds).toContain('n2');
  });

  test('来自另一个库的批次按命名空间导入，重复导入不产生重复条目', async ({ page }) => {
    await setup(page, { packageLibraryId: 'other-lib' });
    // A package from another library is addressed by its own library id; searching
    // the local prefix would not find it at all.
    const previewed = await preview(page, { libraryId: LIBRARY, sourceLibraryId: 'other-lib' });
    expect(previewed.ok, JSON.stringify(previewed.error)).toBe(true);
    expect(previewed.preview!.sameLibrary).toBe(false);
    expect(previewed.preview!.packageLibraryId).toBe('other-lib');
    expect(previewed.preview!.idMappingCount).toBeGreaterThan(0);
    expect(previewed.preview!.warnings.join(' ')).toContain('另一个库');

    const applied = await page.evaluate(
      (id) => window.__selfhubContract!.backup.restore.apply({ previewId: id, mode: 'merge', conflicts: {} }),
      previewed.preview!.previewId
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;
    expect(state.sites.some((row: any) => row.id === 'other-lib:s-new')).toBe(true);
    expect(applied.report!.remapped).toBeGreaterThan(0);

    // Importing the same package again adds nothing new.
    await page.evaluate(
      (state) => window.__selfhubContract!.backup.restore.setCurrentState(state),
      state as never
    );
    const again = await preview(page, { libraryId: LIBRARY, sourceLibraryId: 'other-lib' });
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    const secondApply = await page.evaluate(
      (id) => window.__selfhubContract!.backup.restore.apply({ previewId: id, mode: 'merge', conflicts: {} }),
      again.preview!.previewId
    );
    expect(secondApply.ok, JSON.stringify(secondApply.error)).toBe(true);
    const after = secondApply.state as any;
    const prefixed = after.sites.filter((row: any) => row.id.startsWith('other-lib:'));
    expect(prefixed.map((row: any) => row.id).sort()).toEqual(['other-lib:s-new']);
  });

  test('本机已保存的连接密钥不会被包里的空值覆盖，金库密文原样保留', async ({ page }) => {
    await setup(page);
    const previewed = await preview(page);
    const applied = await page.evaluate(
      (id) => window.__selfhubContract!.backup.restore.apply({ previewId: id, mode: 'merge', conflicts: {} }),
      previewed.preview!.previewId
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;

    expect(state.obsidianConfig.accessKeySecret).toBe('LOCAL-OSS-SECRET');
    expect(state.obsidianConfig.accessKeyId).toBe('LOCAL-ACCESS-ID');
    expect(state.webdavConfig.password).toBe('LOCAL-WEBDAV-PASSWORD');
    expect(state.aiConfig.apiKey).toBe('LOCAL-AI-KEY');
    expect(state.cloudflareSync.syncKey).toBe('LOCAL-SYNC-KEY');

    // The vault ciphertext travels with the package; the master password does not.
    expect(state.secrets.some((row: any) => row.encryptedValue === 'CIPHERTEXT-FROM-BACKUP')).toBe(true);
    expect(applied.report!.pending.join(' ')).toContain('金库主密码');
    expect(JSON.stringify(applied.state)).not.toContain('SHOULD-NOT-SURVIVE');
  });

  test('替换模式用包里的内容覆盖本机集合，本机独有的条目不再保留', async ({ page }) => {
    await setup(page);
    const previewed = await preview(page);
    const applied = await page.evaluate(
      (id) => window.__selfhubContract!.backup.restore.apply({ previewId: id, mode: 'replace', conflicts: {} }),
      previewed.preview!.previewId
    );
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
    const state = applied.state as any;
    expect(state.sites.some((row: any) => row.id === 's-local')).toBe(false);
    expect(state.notes.some((row: any) => row.id === 'n-local')).toBe(false);
    expect(state.sites.find((row: any) => row.id === 's1').title).toBe('备份版站点');
    // Credentials are still local even in replace mode.
    expect(state.obsidianConfig.accessKeySecret).toBe('LOCAL-OSS-SECRET');
  });

  test('没有完成标记的批次不能作为恢复来源', async ({ page }) => {
    const captured: Captured[] = [];
    const files = await mockOss(page, captured);
    await resetApp(page);
    await page.evaluate(
      (state) => window.__selfhubContract!.backup.restore.setCurrentState(state),
      localState() as never
    );
    // A lone object with no marker: exactly what an interrupted upload leaves.
    files.set(`vault/.selfhub/v3/${LIBRARY}/${await appDeviceId(page)}/gen-partial/objects/state.json`, '{"v":3}');

    const result = await preview(page, { generationId: 'gen-partial' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  test('密码不正确时拒绝预览，且不写入任何东西', async ({ page }) => {
    await setup(page);
    const before = await page.evaluate(() => JSON.stringify(window.__selfhubContract!.backup.restore.currentState()));
    const result = await page.evaluate(
      ([generationId, libraryId, device]) =>
        window.__selfhubContract!.backup.restore.preview({
          kind: 'oss',
          config: {
            bucket: 'selfhub-restore-test',
            endpoint: 'oss-cn-beijing.aliyuncs.com',
            region: 'cn-beijing',
            accessKeyId: 'LTAI5tTestKeyForSigning',
            accessKeySecret: 'test-secret',
            prefix: 'vault/'
          },
          password: 'wrong-password',
          generationId,
          libraryId,
          deviceId: device
        }),
      ['gen-restore-1', LIBRARY, await appDeviceId(page)] as const
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AUTH_FAILED');
    const after = await page.evaluate(() => JSON.stringify(window.__selfhubContract!.backup.restore.currentState()));
    expect(after).toBe(before);
  });

  test('连点「应用恢复」不会应用两次，也不会留下错误提示', async ({ page }) => {
    await setup(page, { localViaInitScript: true });
    await page.goto('/#/settings/storage');
    await page.reload();
    await expect(page.locator('[data-testid="v3-backup-section"]')).toBeVisible();

    await page.locator('[data-testid="v3-password-input"]').fill(PASSWORD);
    await page.locator('[data-testid="v3-unlock"]').click();
    await expect(page.locator('[data-testid="v3-preview-batch"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="v3-preview-batch"]').first().click();
    await expect(page.locator('[data-testid="v3-restore-preview"]')).toBeVisible({ timeout: 10_000 });

    const apply = page.locator('[data-testid="v3-apply-restore"]');
    await apply.click();
    await apply.click({ force: true, timeout: 2000 }).catch(() => undefined);

    await expect(page.locator('[data-testid="v3-restore-applied"]')).toBeVisible({ timeout: 20_000 });
    // A second apply would fail on the consumed preview and surface an error after the first
    // one already succeeded — the confusing "it worked, but it says it did not" case.
    await expect(page.locator('[data-testid="v3-error"]')).toHaveCount(0);
  });

  test('设置页可用：解锁 → 预览差异 → 选冲突处理 → 应用，并留下回滚快照', async ({ page }) => {
    await setup(page, { localViaInitScript: true });
    // A hash-only `goto` would be a same-document navigation, so the pre-boot seed
    // would never run and the app would keep its in-memory state. Reload for real.
    await page.goto('/#/settings/storage');
    await page.reload();
    await expect(page.locator('[data-testid="v3-backup-section"]')).toBeVisible();

    await page.locator('[data-testid="v3-password-input"]').fill(PASSWORD);
    await page.locator('[data-testid="v3-unlock"]').click();

    // The batch list only appears once the session password lets it read manifests.
    await expect(page.locator('[data-testid="v3-preview-batch"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="v3-preview-batch"]').first().click();

    const preview = page.locator('[data-testid="v3-restore-preview"]');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await expect(preview).toContainText('恢复预览');
    // The report names the conflicting collections in plain language.
    await expect(preview.locator('[data-preview-collection="notes"]')).toContainText('冲突 1');
    await expect(preview.locator('[data-preview-collection="sites"]')).toContainText('新增 1');
    await expect(preview.locator('[data-testid="v3-preview-credentials"]')).toContainText('不会用空值覆盖');
    await expect(preview.locator('[data-testid="v3-preview-credentials"]')).toContainText('金库主密码');

    // Take the backup's version of the conflicting notes; leave everything else local.
    await preview.locator('[data-testid="v3-conflict-choice"][data-collection="notes"][data-strategy="use-backup"]').click();
    await expect(
      preview.locator('[data-testid="v3-conflict-choice"][data-collection="notes"][data-strategy="use-backup"]')
    ).toHaveAttribute('data-active', 'true');
    await page.locator('[data-testid="v3-apply-restore"]').click();

    await expect(page.locator('[data-testid="v3-restore-applied"]')).toBeVisible({ timeout: 10_000 });

    // The app's payload really changed: the backup's note won, the local-only one stayed.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const raw = localStorage.getItem('self_hub_data_v2');
            const state = raw ? JSON.parse(raw) : null;
            const notes = (state?.notes ?? []) as Array<{ id: string; title: string }>;
            return {
              n1: notes.find((note) => note.id === 'n1')?.title,
              hasLocalOnly: notes.some((note) => note.id === 'n-local')
            };
          }),
        { timeout: 10_000 }
      )
      .toEqual({ n1: '备份版笔记', hasLocalOnly: true });

    // A rollback snapshot was taken before the merge, so the change is undoable.
    const hasRollback = await page.evaluate(() => Boolean(sessionStorage.getItem('self_hub_rollback_snapshot')));
    expect(hasRollback).toBe(true);

    // And the app still renders after a restore (no half-applied state).
    await expect(page.locator('main')).toBeVisible();
  });

  test('截图：恢复预览面板（桌面）', async ({ page }) => {
    await setup(page, { localViaInitScript: true });
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.goto('/#/settings/storage');
    await page.reload();
    await page.locator('[data-testid="v3-password-input"]').fill(PASSWORD);
    await page.locator('[data-testid="v3-unlock"]').click();
    await expect(page.locator('[data-testid="v3-preview-batch"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="v3-preview-batch"]').first().click();
    await expect(page.locator('[data-testid="v3-restore-preview"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="v3-restore-preview"]').screenshot({
      path: 'docs/screenshots/p2-settings-v3-restore-preview.png'
    });
  });
});
