import { test, expect, type Page } from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {
  COLLECTION_KEYS,
  FIXTURES,
  OPTIONAL_COLLECTION_KEYS,
  STORAGE_KEY,
  absentCollections,
  countCollections,
  loadFixtureJson,
  loadFixtureText,
  seedFixture,
  v2Full,
  v2Messy,
  type FixtureId
} from '../fixtures/migrations';
import { readState } from './helpers';

/**
 * P0-02「建立全模块脱敏夹具与恢复样本」的回归测试。
 *
 * 这里只读夹具、不做任何写入：仓库里不会出现真实密钥，每一种失败模式都有
 * 明确的预期结果（见 tests/fixtures/migrations/README.md），并且验证脏数据
 * 导入失败时不会覆盖旧数据。
 */

const SHARED_ANNOTATION_URL = 'https://annotated.fixture.invalid/article';
const EXPORT_PASSWORD = 'fixture-pass-not-a-real-secret';

/** 真实密钥形态黑名单：夹具文件命中任何一条即视为验收失败。 */
const FORBIDDEN_SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /LTAI[A-Za-z0-9]{12,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./
];

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** 读取 localStorage 里的抢救键（损坏 JSON 专用）。 */
async function readSalvageKeys(page: Page): Promise<{ key: string; value: string | null }[]> {
  return page.evaluate((key) => {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(`${key}__corrupt_`))
      .map((k) => ({ key: k, value: localStorage.getItem(k) }));
  }, STORAGE_KEY);
}

/**
 * 用 Hash 路由切换视图（P1-01 的稳定契约），而不是依赖会改名的导航文案。
 */
async function gotoRoute(page: Page, hash: string) {
  const base = page.url().replace(/#.*$/, '');
  await page.goto(`${base}${hash}`);
  await expect(page.locator('main')).toBeVisible();
}

/** 打开「设置 → 数据与维护」：URL 决定分区，点击只是兜底。 */
async function openDataSettings(page: Page) {
  await gotoRoute(page, '#/settings/data');
  const dataNav = page.locator('[data-settings-nav="data"]');
  if (await dataNav.count()) await dataNav.first().click();
  await expect(page.locator('button', { hasText: '导出加密包' })).toBeVisible();
}

test.describe('P0-02 夹具注册表与文件完整性', () => {
  test('四个夹具都被登记，文件存在，raw 标记与实际能否解析一致', () => {
    expect(FIXTURES.map((f) => f.id).sort()).toEqual(['v2-broken', 'v2-full', 'v2-messy', 'v2-minimal']);

    for (const fixture of FIXTURES) {
      const text = loadFixtureText(fixture.id);
      expect(text.length, `${fixture.file} 不应为空`).toBeGreaterThan(0);
      expect(text.length, `${fixture.file} 必须远小于 60KB`).toBeLessThan(60 * 1024);
      expect(fixture.purpose.length, `${fixture.file} 必须说明用途`).toBeGreaterThan(0);
      expect(fixture.expect.length, `${fixture.file} 必须登记预期结果`).toBeGreaterThan(0);

      if (fixture.raw) {
        expect(() => JSON.parse(text), `${fixture.file} 必须是故意损坏的 JSON`).toThrow();
      } else {
        expect(() => JSON.parse(text), `${fixture.file} 必须是合法 JSON`).not.toThrow();
      }
    }
  });

  test('夹具文件不含任何真实密钥形态，且凭据可反解为虚构标记', () => {
    for (const fixture of FIXTURES) {
      const text = loadFixtureText(fixture.id);
      for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
        expect(text, `${fixture.file} 命中真实密钥形态 ${pattern}`).not.toMatch(pattern);
      }
      expect(
        text,
        `${fixture.file} 必须使用 .invalid 虚构域名或 TESTKEY-not-a-real 标记`
      ).toMatch(/TESTKEY-not-a-real|fixture\.invalid|example\.invalid/);
    }

    // 金库密文必须是虚构标记的 Base64，而不是任何真实密文。
    for (const secret of v2Full.secrets) {
      const decoded = Buffer.from(secret.encryptedValue, 'base64').toString('utf-8');
      expect(decoded).toMatch(/^TESTKEY-not-a-real-secret-\d{4}$/);
      expect(Buffer.from(secret.iv, 'base64').toString('utf-8')).toMatch(/^FIXTURE-IV-\d{4}$/);
      expect(Buffer.from(secret.salt, 'base64').toString('utf-8')).toMatch(/^FIXTURE-SALT-\d{4}$/);
    }
  });

  // 「播种 → 读回」不得改动夹具文件：文件 hash 与集合数量都必须原样。
  for (const id of ['v2-full', 'v2-messy', 'v2-minimal'] as const) {
    test(`播种并读回 ${id} 不会改动夹具文件的原始计数`, async ({ page }) => {
      const beforeText = loadFixtureText(id);
      const beforeCounts = countCollections(JSON.parse(beforeText));
      const beforeHash = sha256(beforeText);

      await seedFixture(page, id);
      await page.goto('/');
      await expect(page.locator('main')).toBeVisible();
      await page.reload();
      await expect(page.locator('main')).toBeVisible();

      const afterText = loadFixtureText(id);
      expect(sha256(afterText), `${id} 文件内容被测试改动了`).toBe(beforeHash);
      expect(countCollections(JSON.parse(afterText)), `${id} 夹具计数被归一化改动了`).toEqual(beforeCounts);

      // 归一化只能补全缺失集合，绝不能凭空减少任何集合的数量。
      await expect
        .poll(async () => {
          const state = (await readState(page)) as any;
          return COLLECTION_KEYS.every((key) => Array.isArray(state[key]));
        })
        .toBe(true);
      const persisted = (await readState(page)) as any;
      for (const key of COLLECTION_KEYS) {
        const fromFile = Array.isArray((JSON.parse(afterText) as any)[key])
          ? (JSON.parse(afterText) as any)[key].length
          : 0;
        expect(
          persisted[key].length,
          `${id}.${key} 在归一化后从 ${fromFile} 变成了 ${persisted[key].length}`
        ).toBeGreaterThanOrEqual(fromFile);
      }
    });
  }
});

test.describe('v2-full.json：完整状态往返', () => {
  test.beforeEach(async ({ page }) => {
    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
  });

  test('应用启动后全集合数量原地往返，没有集合被静默丢弃', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    const expected = countCollections(v2Full);
    expect(expected.sites).toBeGreaterThan(0);
    expect(expected.notes).toBeGreaterThan(0);

    await expect.poll(async () => countCollections(await readState(page))).toEqual(expected);

    // reload 后 addInitScript 会重新写入原始载荷，应用再覆盖主键：
    // 读回的仍然是应用的输出，因此这验证的是持久化往返，不是夹具本身。
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    await expect.poll(async () => countCollections(await readState(page))).toEqual(expected);

    const persisted = (await readState(page)) as any;
    expect(persisted.obsidianConfig.accessKeyId).toBe('TESTKEY-not-a-real-oss-id');
    expect(persisted.wucaiConfig.token).toBe('TESTKEY-not-a-real-wucai-token');
    expect(persisted.youdaoConfig.token).toBe('TESTKEY-not-a-real-youdao-token');
    expect(persisted.aiConfig.provider).toBe('deepseek');
    expect(persisted.cloudflareSync.workerUrl).toBe('https://sync.fixture.invalid/state');
    expect(persisted.webdavConfig.username).toBe('fixture-user@example.invalid');
    expect(persisted.gotabPrefs.wallpaperType).toBe('custom');
    // P1 新增的对象型字段同样必须往返，而不是被默认值覆盖。
    // `format` 是 P2-05 新增的字段：fixture 里没有它，因此由规范化补上缺省
    // `legacy`——这正是「未显式启用 v3 的老数据继续用旧格式」的落点。
    expect(persisted.backupPolicy).toMatchObject({ provider: 'webdav', enabled: false });
    expect(persisted.backupPolicy.format).toBe('legacy');
    expect(persisted.homeBlocks.find((b: any) => b.id === 'todo')).toEqual({
      id: 'todo',
      hidden: false,
      collapsed: true
    });
    expect(persisted.connectionTests.obsidian.fingerprint).toBe('fixture-fingerprint-0001');
    expect(persisted.purposes['remote-vault']).toBe(true);
    expect(persisted.sampleBatch).toEqual(['full-site-0003', 'full-note-0002']);
    expect(persisted.theme).toBe('dark');
    expect(errors).toEqual([]);
  });

  test('加密导出 → 隔离环境恢复：逐集合数量与文件哈希可记录', async ({ page }, testInfo) => {
    const expected = countCollections(v2Full);
    await expect.poll(async () => countCollections(await readState(page))).toEqual(expected);

    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept(dialog.type() === 'prompt' ? EXPORT_PASSWORD : undefined);
    });

    await openDataSettings(page);

    // 未设置主密码时，第一次点击只展开密码输入框。
    // 选择器用的是导出框自己的完整占位文本：P2-05 的 v3 备份密码输入框占位里
    // 也含「主密码」三个字，用子串匹配会同时命中两个输入框。
    await page.locator('button', { hasText: '导出加密包' }).click();
    await page.locator('input[placeholder="输入加密密钥 / 主密码..."]').fill(EXPORT_PASSWORD);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button', { hasText: '确认导出' }).click()
    ]);
    expect(download.suggestedFilename()).toMatch(/^self-hub-encrypted-backup-.*\.enc\.json$/);

    const artifactPath = await download.path();
    expect(artifactPath).toBeTruthy();
    const artifact = fs.readFileSync(artifactPath as string);
    const artifactText = artifact.toString('utf-8');
    const payload = JSON.parse(artifactText);

    expect(payload.app).toBe('self-hub');
    expect(payload.schemaVersion).toBe(2);
    expect(typeof payload.encryptedData).toBe('string');
    expect(payload.encryptedData.length).toBeGreaterThan(0);
    // 密文文件里必须看不到任何明文凭据 / 域名。
    expect(artifactText).not.toContain('TESTKEY-not-a-real');
    expect(artifactText).not.toContain('fixture.invalid');
    expect(payload.summary).toEqual({
      sitesCount: expected.sites,
      notesCount: expected.notes,
      secretsCount: expected.secrets,
      serversCount: expected.servers,
      projectsCount: expected.projects,
      remindersCount: expected.reminders,
      inboxCount: expected.inbox
    });

    const artifactHash = sha256(artifact);
    // 记录产物 hash 与逐集合数量（供 P0-02 验收留痕；密文含随机 salt/iv，hash 每次不同）。
    console.log(
      `[P0-02] 加密导出产物 sha256=${artifactHash} bytes=${artifact.length} summary=${JSON.stringify(payload.summary)}`
    );
    testInfo.annotations.push({
      type: 'encrypted-export',
      description: `${download.suggestedFilename()} sha256=${artifactHash} bytes=${artifact.length}`
    });

    // ---- 隔离环境：全新的浏览器上下文，除了 onboarded 标记什么都没有 ----
    const origin = new URL(page.url()).origin;
    const isolated = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await isolated.addInitScript(() => window.localStorage.setItem('selfhub_onboarded', '1'));
      const fresh = await isolated.newPage();
      const restoreDialogs: string[] = [];
      fresh.on('dialog', async (dialog) => {
        restoreDialogs.push(dialog.message());
        await dialog.accept(dialog.type() === 'prompt' ? EXPORT_PASSWORD : undefined);
      });

      await fresh.goto(`${origin}/`);
      await expect(fresh.locator('main')).toBeVisible();
      // 等到应用把初始状态写进主键：新档案可能是空集合（P1-03），
      // 所以这里断言的是“没有夹具数据”，而不是“有多少条数据”。
      await expect
        .poll(async () => {
          const state = (await readState(fresh)) as any;
          return Boolean(state) && Array.isArray(state.sites) && Array.isArray(state.notes);
        })
        .toBe(true);
      const preImportState = (await readState(fresh)) as any;
      const preImport = countCollections(preImportState);
      expect(preImportState.sites.some((s: any) => s.id === 'full-site-0001')).toBe(false);
      expect(preImportState.notes.some((n: any) => n.id === 'full-note-0001')).toBe(false);
      expect(preImport).not.toEqual(expected);

      await openDataSettings(fresh);
      await fresh.setInputFiles('[data-testid="import-backup-file"]', {
        name: download.suggestedFilename(),
        mimeType: 'application/json',
        buffer: artifact
      });

      await expect.poll(() => restoreDialogs.some((m) => m.includes('加密备份已成功解密并恢复'))).toBe(true);
      await expect.poll(async () => countCollections(await readState(fresh))).toEqual(expected);

      // 旧数据（隔离环境里的 INITIAL_STATE）没有被静默吞掉：导入前状态进了回滚快照。
      const rollback = await fresh.evaluate(() => sessionStorage.getItem('self_hub_rollback_snapshot'));
      expect(rollback, '导入前应写入回滚快照').toBeTruthy();
      const snapshot = JSON.parse(rollback as string);
      expect(countCollections(snapshot)).toEqual(preImport);
      expect(snapshot.sites.some((s: any) => s.id === 'full-site-0001')).toBe(false);
      expect(snapshot.notes.some((n: any) => n.id === 'full-note-0001')).toBe(false);
    } finally {
      await isolated.close();
    }
  });
});

test.describe('v2-messy.json：脏数据存活', () => {
  test.beforeEach(async ({ page }) => {
    await seedFixture(page, 'v2-messy');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
  });

  test('同一 URL、不同文本的两条批注都存活', async ({ page }) => {
    const expected = v2Messy.annotations.filter((a: any) => a.pageUrl === SHARED_ANNOTATION_URL);
    expect(expected, '夹具必须包含同 URL 的批注').toHaveLength(2);
    expect(new Set(expected.map((a: any) => a.text)).size, '两条批注文本必须不同').toBe(2);

    await expect.poll(async () => ((await readState(page)) as any).annotations.length).toBe(3);
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    await expect.poll(async () => ((await readState(page)) as any).annotations.length).toBe(3);

    const persisted = (await readState(page)) as any;
    const shared = persisted.annotations.filter((a: any) => a.pageUrl === SHARED_ANNOTATION_URL);
    expect(shared, '同 URL 的两条批注不得被去重').toHaveLength(2);
    expect(shared.map((a: any) => a.id).sort()).toEqual(expected.map((a: any) => a.id).sort());
    expect(shared.map((a: any) => a.text).sort()).toEqual(expected.map((a: any) => a.text).sort());
  });

  test('孤立项目引用不会让项目视图崩溃', async ({ page }) => {
    // The project page is now name + one block of text (the user asked to drop the
    // association hub), so orphan references are simply not rendered — but the messy fixture
    // still has to load, show the project, and never throw.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoRoute(page, '#/projects');
    await expect(page.locator('main')).toContainText('Fixture 孤立引用项目');

    await page.locator('main').getByText('Fixture 孤立引用项目').first().click();
    await expect(page.getByTestId('project-editor')).toBeVisible();

    // The orphan ids are still in the payload: the page stopped *editing* them, it did not
    // delete them — a later feature (or an export) must still see them.
    await expect
      .poll(async () => ((await readState(page)) as any).projects[0].noteIds)
      .toContain('ghost-note-9999');
    expect(errors).toEqual([]);
  });

  test('大手绘 dataUrl 与月末 / 闰日提醒原样存活', async ({ page }) => {
    await expect.poll(async () => ((await readState(page)) as any).reminders.length).toBe(3);
    const persisted = (await readState(page)) as any;

    expect(persisted.handwritings).toHaveLength(1);
    expect(persisted.handwritings[0].dataUrl).toBe(v2Messy.handwritings[0].dataUrl);
    expect(persisted.handwritings[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(persisted.handwritings[0].dataUrl.length).toBeGreaterThan(400);

    const reminders = Object.fromEntries(persisted.reminders.map((r: any) => [r.id, r]));
    // 月末（2026-10-31）与闰日（2028-02-29）锚点必须原样保留：autoRollover=false 时不得顺延。
    expect(reminders['messy-rem-0001'].targetDate).toBe(1793404800000);
    expect(reminders['messy-rem-0002'].targetDate).toBe(1835395200000);
    expect(new Date(reminders['messy-rem-0002'].targetDate).toISOString()).toBe('2028-02-29T00:00:00.000Z');

    // 手绘视图能渲染这张大图且不报错。
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await gotoRoute(page, '#/tools/drawing/new');
    await expect(page.locator('main')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('引用缺失附件的笔记原样保留（附件本身缺失是预期的）', async ({ page }) => {
    const persisted = (await readState(page)) as any;
    const note = persisted.notes.find((n: any) => n.id === 'src-0001');
    expect(note).toBeTruthy();
    expect(note.content).toContain('missing-fixture-diagram.png');
    expect(note.content).toContain('missing-fixture-attachment.pdf');
    expect(note.attachments).toEqual(['FixtureVault/图片位置/missing-fixture-diagram.png']);
  });

  test('根级未知字段在应用首次持久化后仍然保留（P0-02 已修复）', async ({ page }) => {
    // 夹具文件里确实带着这些字段；P2 迁移要求它们在往返后仍然存在。
    expect(v2Messy.legacyVersion).toBe(1);
    expect(Array.isArray(v2Messy.customSections)).toBe(true);
    expect(v2Messy.extensionMirror).toBeTruthy();
    expect(v2Messy.legacyIdbMirror.stores.sites[0].id).toBe('src-0001');
    expect(loadFixtureJson('v2-messy').extensionMirror.source).toBe('chrome.storage.local');

    // P0-02 发现「未知根级字段首次持久化即被丢弃」。normalizeHubState() 现在显式
    // 保留它不认识的一级字段，因此应用启动并写回后，这些字段必须还在——否则 P2
    // 迁移拿不到旧 IDB / chrome.storage 的原始材料。
    await expect
      .poll(async () => ((await readState(page)) as any).legacyVersion)
      .toBe(1);
    const persisted = (await readState(page)) as any;
    expect(persisted.customSections).toEqual(v2Messy.customSections);
    expect(persisted.extensionMirror).toEqual(v2Messy.extensionMirror);
    expect(persisted.legacyIdbMirror).toEqual(v2Messy.legacyIdbMirror);
    // 已知集合同样不受影响。
    expect(persisted.sites.length).toBe(2);
    expect(persisted.annotations.length).toBe(3);
  });
});

test.describe('v2-minimal.json：缺失集合归一化', () => {
  test('缺失的可选集合被补成空数组，应用不白屏', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await seedFixture(page, 'v2-minimal');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const raw = loadFixtureJson('v2-minimal');
    // 文件里确实缺了这些集合（不是恰好为空）。
    expect(absentCollections(raw).sort()).toEqual([...OPTIONAL_COLLECTION_KEYS].sort());
    for (const key of OPTIONAL_COLLECTION_KEYS) {
      expect(raw[key], `v2-minimal.json 不应包含 ${key}（否则测不到归一化）`).toBeUndefined();
    }
    expect(raw.categories).toBeUndefined();
    expect(raw.obsidianConfig).toBeUndefined();
    expect(raw.gotabPrefs).toBeUndefined();
    expect(raw.checkIns, 'checkIns 是必填集合之外的字段，必须缺失').toBeUndefined();

    // 等到应用把归一化后的状态写回主键（checkIns 出现即证明已持久化）。
    await expect.poll(async () => ((await readState(page)) as any).checkIns).not.toBeUndefined();
    const persisted = (await readState(page)) as any;

    for (const key of OPTIONAL_COLLECTION_KEYS) {
      expect(Array.isArray(persisted[key]), `${key} 应为数组`).toBe(true);
      expect(persisted[key], `${key} 应为空数组`).toHaveLength(0);
    }

    // categories 不是「集合」，缺失时回落为默认分类而不是空数组。
    expect(Array.isArray(persisted.categories)).toBe(true);
    expect(persisted.categories.length).toBeGreaterThan(0);
    expect(persisted.categories[0]).toBe('全部');

    // 缺失的配置对象补默认值。
    expect(persisted.obsidianConfig.enabled).toBe(false);
    expect(persisted.obsidianConfig.prefix).toBe('vault/');
    expect(persisted.aiConfig.provider).toBe('gemini');
    expect(persisted.cloudflareSync.enabled).toBe(false);
    expect(persisted.webdavConfig.pathPrefix).toBe('selfhub_sync');
    expect(persisted.gotabPrefs.searchEngine).toBe('google');

    // 夹具自带的必填集合仍在。
    expect(persisted.sites).toHaveLength(1);
    expect(persisted.notes).toHaveLength(1);
    expect(persisted.reminders).toHaveLength(1);

    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('v2-broken.json：损坏载荷兜底', () => {
  test('损坏 JSON 不白屏，原始字节被移入 self_hub_data_v2__corrupt_* 抢救键', async ({ page }) => {
    const brokenText = loadFixtureText('v2-broken');
    expect(() => JSON.parse(brokenText), 'v2-broken.json 必须是坏 JSON').toThrow();
    expect(brokenText.trimEnd().endsWith('}'), '文件必须在对象中途被截断').toBe(false);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await seedFixture(page, 'v2-broken');
    await page.goto('/');

    // 1) 应用仍然渲染主界面。
    await expect(page.locator('main')).toBeVisible();

    // 2) 损坏载荷被复制到抢救键，原始字符串未被改写。
    const salvage = await readSalvageKeys(page);
    expect(salvage.length, '应出现 self_hub_data_v2__corrupt_* 抢救键').toBeGreaterThanOrEqual(1);
    expect(salvage[0].key).toMatch(new RegExp(`^${STORAGE_KEY}__corrupt_\\d+$`));
    expect(salvage[0].value).toBe(brokenText);

    // 3) 主键被替换为可归一化读取的状态，坏数据没有被半应用。
    await expect
      .poll(async () => {
        const raw = await page.evaluate((key: string) => localStorage.getItem(key), STORAGE_KEY);
        if (!raw) return false;
        try {
          const parsed = JSON.parse(raw);
          return parsed.schemaVersion === 2 && Array.isArray(parsed.sites);
        } catch {
          return false;
        }
      })
      .toBe(true);
    const persistedRaw = await page.evaluate((key: string) => localStorage.getItem(key), STORAGE_KEY);
    expect(persistedRaw, '主键不应继续保存损坏载荷').not.toBe(brokenText);
    const persisted = JSON.parse(persistedRaw as string);
    expect(persisted.sites.some((s: any) => s.id === 'broken-site-0001')).toBe(false);
    expect(persisted.servers.some((s: any) => s.id === 'broken-srv-0001')).toBe(false);
    for (const key of COLLECTION_KEYS) {
      expect(Array.isArray(persisted[key]), `${key} 应被归一化为数组`).toBe(true);
    }
    expect(errors).toEqual([]);

    // 4) 刷新后依然可用（init script 再次写入坏数据 → 再次产生抢救键）。
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    const salvageAfterReload = await readSalvageKeys(page);
    expect(salvageAfterReload.length).toBeGreaterThanOrEqual(1);
    expect(salvageAfterReload.every((entry) => entry.value === brokenText)).toBe(true);
  });
});

test.describe('导入保护：脏夹具不得覆盖旧数据', () => {
  test('跨集合重复 ID 的明文导入被接受（同集合内重复仍被拒绝），现有数据不被半应用', async ({ page }) => {
    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const before = countCollections(v2Full);
    await expect.poll(async () => countCollections(await readState(page))).toEqual(before);

    // 夹具本身确实包含跨集合重复 ID。
    const messyIds = COLLECTION_KEYS.flatMap((key) =>
      Array.isArray((v2Messy as any)[key]) ? (v2Messy as any)[key].map((item: any) => item.id) : []
    );
    const duplicated = messyIds.filter((id, index) => messyIds.indexOf(id) !== index);
    expect(duplicated.length, 'v2-messy 必须包含跨集合重复 ID').toBeGreaterThan(0);

    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });

    await openDataSettings(page);
    await page.setInputFiles('[data-testid="import-backup-file"]', {
      name: 'v2-messy.json',
      mimeType: 'application/json',
      buffer: Buffer.from(loadFixtureText('v2-messy'), 'utf-8')
    });

    // P0-02 查出：validateHubState 曾用一个跨集合共用的 seenIds，于是「站点和服务
    // 器恰好同 ID」这种合法情况会让整份备份被拒绝。ID 只需在集合内唯一，因此导入
    // 现在被接受。夹具里每个集合内部都没有重复 ID，这一点先断言清楚。
    for (const key of COLLECTION_KEYS) {
      const ids = Array.isArray((v2Messy as any)[key]) ? (v2Messy as any)[key].map((i: any) => i.id) : [];
      expect(new Set(ids).size, `${key} 集合内部不应有重复 ID`).toBe(ids.length);
    }

    // 导入成功：以「恢复成功」提示为准，而不是旧版的「恢复中止」。
    await expect.poll(() => dialogs.length).toBeGreaterThanOrEqual(1);
    const messages = dialogs.join('\n');
    expect(messages).not.toContain('重复 ID');
    expect(messages).toContain('恢复');

    // 覆盖前先留下了回滚快照，旧数据可取回。
    const rollback = await page.evaluate(() => sessionStorage.getItem('self_hub_rollback_snapshot'));
    expect(rollback, '导入前应留下会话内回滚快照').toBeTruthy();

    // 导入后的集合与夹具一致（跨集合同 ID 的两条记录都存在，没有被静默合并）。
    const persisted = (await readState(page)) as any;
    expect(persisted.sites.length).toBe((v2Messy as any).sites.length);
    expect(persisted.annotations.length).toBe((v2Messy as any).annotations.length);
  });
});

test.describe('清空存储后的兜底', () => {
  test('清空 localStorage 后重载得到可用的空状态，而不是上一轮的夹具数据', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await expect(page.locator('main')).toBeVisible();

    // 新档案的集合可以为空（P1-03 不再预置示例数据），但必须是可用的完整 HubState。
    await expect
      .poll(async () => {
        const state = (await readState(page)) as any;
        return Boolean(state) && Array.isArray(state.sites) && Array.isArray(state.notes);
      })
      .toBe(true);
    const persisted = (await readState(page)) as any;
    for (const key of COLLECTION_KEYS) {
      expect(Array.isArray(persisted[key]), `${key} 应被归一化为数组`).toBe(true);
    }
    expect(persisted.sites.some((s: any) => s.id === 'full-site-0001')).toBe(false);
    expect(countCollections(persisted).projects).toBe(0);
  });
});
