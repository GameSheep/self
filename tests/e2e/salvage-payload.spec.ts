import { test, expect } from '@playwright/test';
import { seedState, baseState, openSettings, readState, STORAGE_KEY } from './helpers';

/**
 * P0-02 finding, now closed: a damaged payload used to be copied to a
 * `self_hub_data_v2__corrupt_<ts>` key that only DevTools could reach. The data
 * was technically preserved and practically lost. 高级与维护 now lists it,
 * exports the raw bytes and deletes it with an explicit confirmation.
 */

const SALVAGE_KEY = `${STORAGE_KEY}__corrupt_1700000000000`;
const BROKEN = '{"sites":[{"id":"x","title":"半条记录"';

test.describe('损坏载荷抢救入口', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('没有抢救副本时说明情况，而不是显示一个空列表', async ({ page }) => {
    await seedState(page, baseState());
    await openSettings(page, 'maintenance');
    await expect(page.getByTestId('salvage-empty')).toBeVisible();
    await expect(page.getByTestId('salvage-list')).toHaveCount(0);
  });

  test('抢救副本会列出来，并且可以导出原始字节', async ({ page }) => {
    await seedState(page, baseState());
    // Seed a salvaged payload the way loadHubState would have left it.
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [SALVAGE_KEY, BROKEN] as const
    );
    await page.goto('/#/settings/maintenance');
    await expect(page.getByTestId('settings-page')).toBeVisible();

    const entry = page.locator(`[data-salvage-entry="${SALVAGE_KEY}"]`);
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(SALVAGE_KEY);
    await expect(entry).toContainText('字符');

    // The export must hand back the exact original bytes, not a re-serialised
    // version of the (unparseable) payload.
    const downloadPromise = page.waitForEvent('download');
    await entry.getByRole('button', { name: '导出原始内容' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('self-hub-salvaged-1700000000000');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf-8')).toBe(BROKEN);
  });

  test('删除抢救副本需要确认，并且只删除这一份', async ({ page }) => {
    await seedState(page, baseState());
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [SALVAGE_KEY, BROKEN] as const
    );
    await page.goto('/#/settings/maintenance');
    await expect(page.getByTestId('settings-page')).toBeVisible();

    const entry = page.locator(`[data-salvage-entry="${SALVAGE_KEY}"]`);
    await entry.getByRole('button', { name: '删除' }).click();

    // Destructive action goes through a dialog that says what is lost.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('删除这份抢救副本');
    await expect(dialog).toContainText('永久删除');

    // Cancelling keeps it.
    await page.getByRole('button', { name: '取消' }).click();
    await expect(entry).toBeVisible();

    await entry.getByRole('button', { name: '删除' }).click();
    await page.getByRole('button', { name: '永久删除' }).click();
    await expect(page.getByTestId('salvage-empty')).toBeVisible();

    const remaining = await page.evaluate((key) => window.localStorage.getItem(key), SALVAGE_KEY);
    expect(remaining).toBeNull();
    // The live payload is untouched by salvage cleanup.
    const state = await readState(page);
    expect(Array.isArray(state.sites)).toBe(true);
  });
});
