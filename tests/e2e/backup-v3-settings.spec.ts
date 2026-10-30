import { test, expect } from '@playwright/test';
import { seedState, baseState, openSettings, gotoSettingsPane } from './helpers';

/**
 * P2-05: the v3 encrypted backup as a user-facing feature.
 *
 * Everything before this spec proved the format, the queue and the providers. This
 * one is about the promises the *screen* makes, which are the ones a user can be
 * misled by:
 *
 * - the format is a choice, and choosing v3 does not silently turn the task on;
 * - v3 does not run at all — and uploads nothing — while the backup password is
 *   not unlocked in this session;
 * - what "默认恢复源" and the scope lines say matches what is actually stored;
 * - the legacy path keeps working for anyone who does not opt in.
 */

const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BUCKET = 'selfhub-v3-settings';
const PREFIX = 'vault/';

interface Captured {
  method: string;
  path: string;
  body?: string;
}

function createRemote() {
  const files = new Map<string, string>();
  return {
    files,
    put: (path: string, body: string) => files.set(path, body),
    get: (path: string) => files.get(path),
    remove: (path: string) => files.delete(path),
    keys: () => Array.from(files.keys()).sort()
  };
}

async function mockOss(page: any, captured: Captured[]) {
  const remote = createRemote();

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
      captured.push({ method: 'GET-LIST', path });
      const contents = remote
        .keys()
        .filter((key) => key.startsWith(prefix))
        .map(
          (key) =>
            `<Contents><Key>${key}</Key><Size>${remote.get(key)!.length}</Size>` +
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
      const body = request.postData() ?? '';
      captured.push({ method: 'PUT', path, body });
      remote.put(path, body);
      await route.fulfill({ status: 200, headers: { ...cors, ETag: '"new"' }, body: '' });
      return;
    }

    if (method === 'DELETE') {
      captured.push({ method: 'DELETE', path });
      remote.remove(path);
      await route.fulfill({ status: 204, headers: cors, body: '' });
      return;
    }

    if (method === 'HEAD') {
      captured.push({ method: 'HEAD', path });
      if (remote.get(path) !== undefined) {
        await route.fulfill({
          status: 200,
          headers: { ...cors, 'Last-Modified': new Date().toUTCString(), ETag: '"e"' },
          body: ''
        });
      } else {
        await route.fulfill({ status: 404, headers: cors, body: '' });
      }
      return;
    }

    const stored = remote.get(path);
    captured.push({ method: 'GET', path });
    if (stored === undefined) {
      await route.fulfill({ status: 404, headers: cors, body: '' });
      return;
    }
    await route.fulfill({ status: 200, headers: cors, body: stored });
  });

  return remote;
}

function ossState(overrides: Record<string, unknown> = {}) {
  return baseState({
    obsidianConfig: {
      enabled: true,
      bucket: BUCKET,
      endpoint: ENDPOINT,
      region: 'cn-beijing',
      accessKeyId: 'LTAI5tTestKeyForSigning',
      accessKeySecret: 'test-secret',
      prefix: PREFIX
    },
    backupPolicy: { provider: 'oss', enabled: false, format: 'legacy' },
    // A few records so the scope lines report real counts instead of zeros.
    sites: [
      { id: 's1', title: '示例站点', url: 'https://example.com', category: '技术开发', createdAt: 1 },
      { id: 's2', title: '另一个站点', url: 'https://example.org', category: '技术开发', createdAt: 2 }
    ],
    notes: [{ id: 'n1', title: '示例笔记', content: '# 正文', updatedAt: 1 }],
    reminders: [{ id: 'r1', title: '域名续费', category: 'domain', targetDate: 1_800_000_000_000, createdAt: 1 }],
    ...overrides
  });
}

async function openStorage(page: any) {
  await openSettings(page);
  await gotoSettingsPane(page, 'storage');
  await expect(page.locator('[data-testid="v3-backup-section"]')).toBeVisible();
}

async function toggleTheme(page: any) {
  await page.locator('button[aria-label="切换为明亮主题"]').click();
}

test.describe('P2-05 v3 备份设置接入', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('默认仍是旧格式：说明 v3 需要显式启用，也不会先读目的地', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await page.goto('/');
    await openStorage(page);

    await expect(page.locator('[data-testid="v3-format"]')).toHaveText('legacy');
    await expect(page.locator('[data-testid="v3-auto-reason"]')).toContainText('旧的 state.json 备份格式');
    await expect(page.locator('[data-testid="v3-password-state"]')).toContainText('还没有建立备份密码');
    await expect(page.locator('[data-testid="v3-run"]')).toBeDisabled();
    // Nothing was listed: a user who has not opted in should not pay for it.
    expect(captured.filter((entry) => entry.method === 'GET-LIST')).toEqual([]);
  });
  /**
   * The trap: business data in the v3 library, backup format still legacy.
   *
   * In v3 mode the payload holds only device configuration, so a legacy backup writes a
   * package with no notes, bookmarks or vault entries — it succeeds and looks fine. This
   * pins both halves of the fix: automatic runs are stopped, and the panel says why and
   * offers the one-click way out.
   */
  test('v3 模式下旧格式备份被拦下并说明原因，一键改用 v3 加密备份', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    // The device preference is what the policy resolver reads (it is not part of the payload).
    await page.addInitScript(() => {
      window.localStorage.setItem('selfhub_storage_mode', 'v3');
    });
    await seedState(page, ossState({ backupPolicy: { provider: 'oss', enabled: true, format: 'legacy' } }));
    await page.goto('/');
    await openStorage(page);

    // The panel explains it, in the same words the automatic status uses.
    await expect(page.locator('[data-testid="v3-format-warning"]')).toBeVisible();
    await expect(page.locator('[data-testid="v3-format-warning"]')).toContainText('不含笔记、收藏或金库条目');

    // The status line says the same thing once the panel has fetched the destination state
    // (the status is fetched on demand, the warning above is already visible without it).
    await page.locator('[data-testid="v3-refresh"]').click();
    await expect(page.locator('[data-testid="v3-auto-reason"]')).toContainText('只包含本机负载');

    // An edit would normally trigger the debounced automatic backup; it must not upload.
    await toggleTheme(page);
    await page.waitForTimeout(6500);
    expect(
      captured.filter((entry) => entry.method === 'PUT').length,
      'v3 模式下旧格式的自动备份不应上传（那份备份没有资料）'
    ).toBe(0);

    // One click switches the format, and the warning goes away.
    await page.locator('[data-testid="v3-format-warning-fix"]').click();
    await expect(page.locator('[data-testid="v3-format"]')).toHaveText('v3');
    await expect(page.locator('[data-testid="v3-format-warning"]')).toHaveCount(0);
  });


  /**
   * Same family as the storage switch: a multi-second action behind one button.
   *
   * Two clicks must not create two generations — the retention policy would absorb it, but
   * the user asked for one backup and would silently get two.
   */
  test('连点「立即创建一次加密备份」只产生一个批次', async ({ page }) => {
    const captured: Captured[] = [];
    const remote = await mockOss(page, captured);
    await seedState(page, ossState({ backupPolicy: { provider: 'oss', enabled: true, format: 'v3' } }));
    await page.goto('/');
    await openStorage(page);

    await page.locator('[data-testid="v3-password-input"]').fill('backup-password-123');
    await page.locator('[data-testid="v3-unlock"]').click();
    await expect(page.locator('[data-testid="v3-password-state"]')).toContainText('已解锁');

    const run = page.locator('[data-testid="v3-run"]');
    // Two clicks without waiting for the first to finish.
    await run.click();
    await run.click({ force: true, timeout: 2000 }).catch(() => undefined);
    await expect(page.locator('[data-testid="v3-message"]')).toContainText('备份完成', { timeout: 20_000 });

    // Every generation writes exactly one completion marker; count distinct ones.
    const markers = remote
      .keys()
      .filter((key) => key.endsWith('_complete.json'))
      .map((key) => key.replace(/\/_complete\.json$/, ''));
    expect(markers.length, `批次：${markers.join(', ')}`).toBe(1);
    await expect(page.locator('[data-testid="v3-batch-count"]')).toHaveText('1');
  });

  test('建立密码后可以创建一次加密备份，界面显示真实批次与范围', async ({ page }) => {
    const captured: Captured[] = [];
    const remote = await mockOss(page, captured);
    await seedState(page, ossState());
    await page.goto('/');
    await openStorage(page);

    await page.locator('[data-testid="v3-password-input"]').fill('backup-password-123');
    await page.locator('[data-testid="v3-unlock"]').click();
    await expect(page.locator('[data-testid="v3-password-state"]')).toContainText('已解锁');

    await page.locator('[data-testid="v3-run"]').click();
    await expect(page.locator('[data-testid="v3-message"]')).toContainText('备份完成');

    // The destination really holds a v3 generation with its marker and pointer.
    const keys = remote.keys();
    expect(keys.some((key) => key.includes('.selfhub/v3/') && key.endsWith('_complete.json'))).toBe(true);
    expect(keys.some((key) => key.endsWith('latest.json'))).toBe(true);
    expect(keys.some((key) => key === `${PREFIX}.selfhub/state.json`)).toBe(false);

    // The panel reports the batch that is actually stored.
    await expect(page.locator('[data-testid="v3-batch-count"]')).toHaveText('1');
    await expect(page.locator('[data-testid="v3-incomplete"]')).toHaveText('0');
    await expect(page.locator('[data-testid="v3-latest"]')).toContainText('gen-');
    // The scope line counts what is really in the package: 2 sites + 1 note + 1 reminder.
    await expect(page.locator('[data-testid="v3-scope-summary"]')).toContainText('4 条记录');
    // Scope lines say what is NOT in the package.
    await expect(page.locator('[data-testid="v3-exclusion"]').first()).toContainText('重新填写');
    // And the upload was encrypted: no plaintext titles in any stored object.
    for (const entry of captured.filter((item) => item.method === 'PUT')) {
      expect(entry.body ?? '').not.toContain('示例站点');
    }
  });

  test('选择 v3 并开启自动备份后，状态变化写的是 v3 批次而不是旧 state.json', async ({ page }) => {
    const captured: Captured[] = [];
    const remote = await mockOss(page, captured);
    await seedState(page, ossState());
    await page.goto('/');
    await openStorage(page);

    // Two independent decisions: the format, then the task switch.
    await page.locator('[data-v3-format-option="v3"]').click();
    await expect(page.locator('[data-testid="v3-format"]')).toHaveText('v3');
    await expect(page.locator('[data-backup-auto-toggle]')).toHaveAttribute('data-enabled', 'false');

    await page.locator('[data-testid="v3-password-input"]').fill('backup-password-123');
    await page.locator('[data-testid="v3-unlock"]').click();
    await page.locator('[data-backup-auto-toggle]').click();
    await expect(page.locator('[data-backup-auto-toggle]')).toHaveAttribute('data-enabled', 'true');

    await toggleTheme(page);
    await page.waitForTimeout(6500); // the auto trigger debounces for 5s

    const keys = remote.keys();
    expect(keys.some((key) => key.includes('.selfhub/v3/'))).toBe(true);
    expect(keys.some((key) => key === `${PREFIX}.selfhub/state.json`)).toBe(false);
    await expect(page.locator('[data-testid="v3-batch-count"]')).toHaveText('1');
  });

  test('v3 已启用但本次会话未解锁时：明确说明不会运行，并且不发任何上传', async ({ page }) => {
    const captured: Captured[] = [];
    const remote = await mockOss(page, captured);
    await seedState(
      page,
      ossState({ backupPolicy: { provider: 'oss', enabled: true, format: 'v3' } })
    );
    // Simulate "was unlocked, then the page was reloaded": only the non-secret hint
    // survives, so the panel must ask again.
    await page.addInitScript(() => {
      localStorage.setItem(
        'selfhub_backup_password_meta',
        JSON.stringify({ establishedAt: Date.now() })
      );
    });
    await page.goto('/');
    await openStorage(page);

    await expect(page.locator('[data-testid="v3-password-state"]')).toContainText('本次会话未解锁');
    await expect(page.locator('[data-testid="v3-auto-reason"]')).toContainText('不会运行');
    await expect(page.locator('[data-testid="v3-run"]')).toBeDisabled();

    // A state change must not trigger the disabled task, and must not fall back to
    // the legacy plaintext path either.
    await toggleTheme(page);
    await page.waitForTimeout(6500);
    expect(captured.filter((entry) => entry.method === 'PUT')).toEqual([]);
    expect(remote.keys()).toEqual([]);
  });

  test('旧格式下「立即备份」仍然写 .selfhub/state.json（未启用 v3 的人不受影响）', async ({ page }) => {
    const captured: Captured[] = [];
    const remote = await mockOss(page, captured);
    await seedState(page, ossState({ backupPolicy: { provider: 'oss', enabled: true, format: 'legacy' } }));
    await page.goto('/');
    await openStorage(page);

    await page.locator('[data-testid="backup-now"]').click();
    await expect
      .poll(() => remote.keys().some((key) => key === `${PREFIX}.selfhub/state.json`), { timeout: 10_000 })
      .toBe(true);
    expect(remote.keys().some((key) => key.includes('.selfhub/v3/'))).toBe(false);
  });

  test('切换格式不会顺手开启自动备份任务（保存、启用、运行三件事分开）', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(page, ossState());
    await page.goto('/');
    await openStorage(page);

    await page.locator('[data-v3-format-option="v3"]').click();
    await expect(page.locator('[data-testid="v3-format"]')).toHaveText('v3');
    // The task switch is still off, and the panel says so rather than implying a
    // running task.
    await expect(page.locator('[data-backup-auto-toggle]')).toHaveAttribute('data-enabled', 'false');
    await expect(page.locator('[data-backup-auto-state]')).toContainText('未开启');

    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? (JSON.parse(raw).backupPolicy as { format?: string; enabled?: boolean }) : null;
    });
    expect(persisted?.format).toBe('v3');
    expect(persisted?.enabled).toBe(false);
  });

  test('截图：v3 备份面板在有数据时的样子（桌面与窄屏）', async ({ page }) => {
    const captured: Captured[] = [];
    await mockOss(page, captured);
    await seedState(
      page,
      ossState({ backupPolicy: { provider: 'oss', enabled: true, format: 'v3' } })
    );
    await page.goto('/');
    await openStorage(page);

    await page.locator('[data-testid="v3-password-input"]').fill('backup-password-123');
    await page.locator('[data-testid="v3-unlock"]').click();
    await page.locator('[data-testid="v3-run"]').click();
    await expect(page.locator('[data-testid="v3-message"]')).toContainText('备份完成');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('[data-testid="v3-backup-section"]').screenshot({
      path: 'docs/screenshots/p2-settings-v3-backup.png'
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-testid="v3-backup-section"]').screenshot({
      path: 'docs/screenshots/p2-settings-v3-backup-narrow.png'
    });
  });
});
