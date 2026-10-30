import { test, expect } from '@playwright/test';
import { gotoSettingsPane, seedState, baseState } from './helpers';

/**
 * 多端备份（3）：WebDAV 备一份，OSS 也备一份。
 *
 * `backupPolicy.destinations` lists every destination that should receive a copy. Each one that
 * is fully configured gets its own upload — previously a single provider won and the other
 * configuration was silently ignored.
 */
const OSS_ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const WEBDAV_HOST = 'dav.example.invalid';

test.describe('多端备份', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('同时勾选 OSS 与 WebDAV 时，两边各收到一份', async ({ page }) => {
    const puts: string[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const isOss = url.includes(OSS_ENDPOINT);
      const isDav = url.includes(WEBDAV_HOST);
      if (!isOss && !isDav) return route.continue();
      if (request.method() === 'OPTIONS') {
        return route.fulfill({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,PUT,POST,PROPFIND,OPTIONS',
            'Access-Control-Allow-Headers': '*'
          },
          body: ''
        });
      }
      if (request.method() === 'PUT' || request.method() === 'POST') puts.push(url);
      if (isDav && request.method() === 'PROPFIND') {
        return route.fulfill({
          status: 207,
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/xml' },
          body: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>'
        });
      }
      return route.fulfill({
        status: isDav ? 201 : 200,
        headers: { 'Access-Control-Allow-Origin': '*', ETag: '"1"' },
        body: ''
      });
    });

    await seedState(
      page,
      baseState({
        obsidianConfig: {
          enabled: true,
          bucket: 'multi-bucket',
          endpoint: OSS_ENDPOINT,
          region: 'oss-cn-beijing',
          accessKeyId: 'LTAI5tMULTITARGET',
          accessKeySecret: 'secret',
          prefix: ''
        },
        webdavConfig: {
          enabled: true,
          url: `https://${WEBDAV_HOST}/dav/`,
          username: 'user',
          password: 'pass',
          pathPrefix: 'selfhub'
        },
        backupPolicy: {
          provider: 'auto',
          enabled: true,
          format: 'legacy',
          destinations: ['oss', 'webdav']
        }
      })
    );
    await page.goto('/#/settings/storage');
    await page.reload();
    await gotoSettingsPane(page, 'storage');

    await expect(page.getByTestId('backup-now')).toBeVisible();
    await page.getByTestId('backup-now').click();

    // One upload per destination, not one provider winning.
    await expect
      .poll(() => puts.filter((url) => url.includes(OSS_ENDPOINT)).length, {
        timeout: 20_000,
        message: 'OSS 应收到一份备份'
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() => puts.filter((url) => url.includes(WEBDAV_HOST)).length, {
        timeout: 20_000,
        message: 'WebDAV 应收到一份备份'
      })
      .toBeGreaterThan(0);
  });

  test('只勾一个时另一份不会发出去', async ({ page }) => {
    const puts: string[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (!url.includes(OSS_ENDPOINT) && !url.includes(WEBDAV_HOST)) return route.continue();
      if (request.method() === 'PUT' || request.method() === 'POST') puts.push(url);
      return route.fulfill({
        status: request.method() === 'OPTIONS' ? 200 : 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,PUT,POST,PROPFIND,OPTIONS',
          'Access-Control-Allow-Headers': '*'
        },
        body: ''
      });
    });

    await seedState(
      page,
      baseState({
        obsidianConfig: {
          enabled: true,
          bucket: 'only-webdav',
          endpoint: OSS_ENDPOINT,
          region: '',
          accessKeyId: 'LTAI5tONLY',
          accessKeySecret: 'secret',
          prefix: ''
        },
        webdavConfig: {
          enabled: true,
          url: `https://${WEBDAV_HOST}/dav/`,
          username: 'user',
          password: 'pass',
          pathPrefix: 'selfhub'
        },
        backupPolicy: { provider: 'auto', enabled: true, format: 'legacy', destinations: ['webdav'] }
      })
    );
    await page.goto('/#/settings/storage');
    await page.reload();
    await gotoSettingsPane(page, 'storage');
    await page.getByTestId('backup-now').click();

    await expect
      .poll(() => puts.filter((url) => url.includes(WEBDAV_HOST)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    expect(puts.filter((url) => url.includes(OSS_ENDPOINT))).toHaveLength(0);
  });
});
