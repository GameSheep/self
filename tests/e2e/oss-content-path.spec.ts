import { test, expect } from '@playwright/test';
import { resetApp, gotoSettingsPane, expandIntegration } from './helpers';

/**
 * 「我的 OSS 里那些 md 到底还能不能看」——从设置里保存配置，再回到远端笔记页。
 *
 * The user asked where the OSS markdown viewer went. It exists (资料库 → 远端笔记（OSS）), and this
 * test walks the whole path a person walks: save the connection in 设置 → 连接与任务, then open
 * 资料库 → 远端笔记（OSS） and see the bucket it is reading from, plus the OSS file list.
 */
const BUCKET = 'example-obsidian-vault';
const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';

function listXml(): string {
  const keys = ['日记/2026-10-19.md', '项目/方案.md', 'README.md'];
  const contents = keys
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2026-10-16T12:00:00.000Z</LastModified><Size>128</Size><ETag>"x"</ETag><StorageClass>Standard</StorageClass></Contents>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix></Prefix><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

test.describe('远端笔记（OSS）依然可用', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (!url.includes(ENDPOINT)) return route.continue();
      if (url.includes('list-type=2') || url.includes('?prefix=') || url.includes('/?') || url.endsWith('/')) {
        return route.fulfill({ status: 200, contentType: 'application/xml', body: listXml() });
      }
      return route.fulfill({ status: 200, contentType: 'text/markdown', body: '# 远端内容\n\n来自 OSS 的正文' });
    });
  });

  test('保存 OSS 连接后，远端笔记页显示该 bucket 并能列出 md 文件', async ({ page }) => {
    await resetApp(page);

    // 1. Save the connection through the UI (not by seeding state).
    await gotoSettingsPane(page, 'connections');
    await expandIntegration(page, 'oss');
    await page.locator('[data-field="oss.bucket"]').fill(BUCKET);
    await page.locator('[data-field="oss.endpoint"]').fill(ENDPOINT);
    await page.locator('[data-field="oss.accessKeyId"]').fill('LTAI5t8JAm7fyYaDsK5ECJer');
    await page.locator('[data-field="oss.accessKeySecret"]').fill('test-secret');
    await page.locator('[data-field="oss.enabled"]').click();
    await page.locator('[data-save="oss"]').click();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('self_hub_data_v2');
          return raw ? (JSON.parse(raw).obsidianConfig?.bucket ?? '') : '';
        })
      )
      .toBe(BUCKET);

    // 2. The sidebar entry added for exactly this: one click from anywhere.
    await page.locator('[data-nav-child="library-sources"]').click();
    await expect(page.getByTestId('library-sources')).toBeVisible();

    // The page names the bucket it reads from — 「未配置」 was the thing that made the feature
    // look missing.
    await expect(page.locator('main')).toContainText(BUCKET);

    // 3. Pull the listing and open a markdown file.
    await page.locator('[data-testid="oss-refresh"]').click();
    await expect(page.locator('main')).toContainText('README.md', { timeout: 15_000 });
  });
});
