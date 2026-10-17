import { test, expect } from '@playwright/test';
import { seedState, baseState, readState } from './helpers';

/**
 * The extension ships its own SyncManager (sites / annotations / inbox / quick
 * note) writing under its own prefix, while the app backs up the whole state to a
 * different location. Both cover the same datasets, so the app must (a) show the
 * extension's real state and (b) warn about the overlap — instead of silently
 * writing everything twice.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState({
    obsidianConfig: {
      enabled: true,
      bucket: 'my-vault',
      endpoint: 'oss-cn-beijing.aliyuncs.com',
      region: 'oss-cn-beijing',
      accessKeyId: 'LTAI-id',
      accessKeySecret: 'secret',
      prefix: ''
    },
    ...overrides
  });
}

/** Pretend to be an extension page with a configured SyncManager. */
async function stubChrome(page: any, syncConfig: Record<string, unknown> | null, status: Record<string, unknown> = {}) {
  await page.addInitScript(
    ([cfg, st]) => {
      (window as any).__syncWrites = [];
      const store: Record<string, unknown> = {};
      if (cfg) store.selfhub_sync_config = cfg;
      store.selfhub_sync_status = st;
      (window as any).chrome = {
        storage: {
          local: {
            get(keys: string[], cb: (items: Record<string, unknown>) => void) {
              const out: Record<string, unknown> = {};
              keys.forEach((k) => (out[k] = store[k]));
              cb(out);
            },
            set(items: Record<string, unknown>, cb?: () => void) {
              Object.assign(store, items);
              (window as any).__syncWrites.push(items);
              cb && cb();
            }
          }
        },
        runtime: {
          id: 'test-ext',
          lastError: null,
          sendMessage(_m: unknown, cb?: (r: unknown) => void) {
            cb && cb({ success: true });
          },
          openOptionsPage() {
            (window as any).__optionsOpened = true;
          },
          getURL: (p: string) => `chrome-extension://test-ext/${p}`
        },
        tabs: { create() {} }
      };
    },
    [syncConfig, status] as const
  );
}

async function openSyncTab(page: any) {
  await page.locator('aside button[title*="系统设置"]').click();
  await expect(page.getByText('系统与服务集成设置')).toBeVisible();
  await page.locator('[data-settings-nav="sync"]').click();
  await expect(page.getByTestId('extension-sync-section')).toBeVisible();
}

test.describe('扩展同步与应用备份的去重', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('非扩展环境说明不适用，无重叠警示', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openSyncTab(page);

    await expect(page.getByTestId('extension-sync-section')).toContainText('当前不是扩展环境');
    await expect(page.getByTestId('sync-overlap-warning')).toHaveCount(0);
  });

  test('扩展同步开启且应用备份也在用时，明确提示重复写入', async ({ page }) => {
    await stubChrome(
      page,
      {
        provider: 'webdav',
        autoSync: true,
        webdav: { serverUrl: 'https://kurio.infini-cloud.net/dav/', username: 'u', pathPrefix: 'self' }
      },
      { lastSyncTime: Date.now() - 3600_000, lastMessage: 'ok', state: 'idle' }
    );
    await seedState(page, state());
    await page.goto('/');
    await openSyncTab(page);

    await expect(page.getByTestId('extension-sync-section')).toContainText('已开启（WEBDAV）');
    await expect(page.getByTestId('extension-sync-section')).toContainText('self/');

    const warning = page.getByTestId('sync-overlap-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('站点/批注会被写两次');
  });

  test('一键关闭扩展同步会写回 chrome.storage', async ({ page }) => {
    await stubChrome(page, {
      provider: 'webdav',
      autoSync: true,
      webdav: { serverUrl: 'https://example.com/dav/', username: 'u', pathPrefix: 'self' }
    });
    await seedState(page, state());
    await page.goto('/');
    await openSyncTab(page);

    await page.getByTestId('extension-sync-toggle').click();
    await expect(page.getByTestId('extension-sync-section')).toContainText('已关闭');

    const writes = await page.evaluate(() => (window as any).__syncWrites);
    const last = writes[writes.length - 1];
    expect(last.selfhub_sync_config.provider).toBe('none');
    expect(last.selfhub_sync_config.disabledByApp).toBe(true);
  });

  test('应用备份未配置时，即使扩展同步开着也不报重叠', async ({ page }) => {
    await stubChrome(page, {
      provider: 'webdav',
      autoSync: true,
      webdav: { serverUrl: 'https://example.com/dav/', username: 'u', pathPrefix: 'self' }
    });
    const noBackup = state();
    (noBackup as any).obsidianConfig = { ...(noBackup as any).obsidianConfig, enabled: false, bucket: '' };
    await seedState(page, noBackup);
    await page.goto('/');
    await openSyncTab(page);

    await expect(page.getByTestId('extension-sync-section')).toContainText('已开启');
    await expect(page.getByTestId('sync-overlap-warning')).toHaveCount(0);
  });

  test('可以跳到扩展的完整设置页', async ({ page }) => {
    await stubChrome(page, { provider: 'none', autoSync: true, s3: {}, webdav: {} });
    await seedState(page, state());
    await page.goto('/');
    await openSyncTab(page);

    await page.getByTestId('open-extension-options').click();
    expect(await page.evaluate(() => (window as any).__optionsOpened)).toBe(true);
  });
});
