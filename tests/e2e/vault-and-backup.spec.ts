import { test, expect } from '@playwright/test';
import { resetApp, readState, visible, openAddModal } from './helpers';

/**
 * Regression tests for the vault / backup flows that used to make the app
 * unusable (hidden unlock dialog, blank page after restoring an old backup,
 * "keep me signed in" that did not survive a reload).
 */

const partialBackup = {
  theme: 'dark',
  sites: [{ id: 's1', title: '备份站点', url: 'https://a.example.com', category: '技术开发', createdAt: 1 }],
  servers: [],
  secrets: [],
  reminders: [],
  notes: [{ id: 'n1', title: '备份笔记', content: 'x', updatedAt: 1 }]
  // deliberately missing: checkIns / handwritings / categories / obsidianConfig
};

test.describe('金库', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
  });

  async function setMasterPassword(page: any, password = 'regression-pass') {
    await page.locator('nav button', { hasText: '加密安全金库' }).click();
    await page.locator('button', { hasText: /解锁金库|初始化/ }).first().click();
    const inputs = page.locator('input[type="password"]');
    await inputs.first().fill(password);
    if ((await inputs.count()) > 1) await inputs.nth(1).fill(password);
    await page.locator('button', { hasText: /完成设置并开启金库|立即解锁/ }).click();
    await expect(page.getByText('金库已解密')).toBeVisible();
  }

  test('设置主密码后新增凭据并加密落盘', async ({ page }) => {
    await setMasterPassword(page);
    await page.locator('button', { hasText: '新建凭据' }).first().click();
    await page.locator('div.fixed.inset-0 button', { hasText: '金库凭据' }).click();
    await visible(page, 'input[placeholder*="Gemini"]').fill('回归凭据');
    await visible(page, 'input[placeholder*="粘贴完整"]').fill('sk-regression-1234567890');
    await page.locator('div.fixed.inset-0 button', { hasText: '保存资产' }).click();

    await expect.poll(async () => (await readState(page)).secrets.length).toBe(1);
    const secret = (await readState(page)).secrets[0];
    expect(secret.encryptedValue).toBeTruthy();
    expect(secret.encryptedValue).not.toContain('sk-regression');
    expect(secret.maskedPreview).toContain('••');
  });

  test('金库锁定时录入凭据：解锁弹窗必须可交互（不被遮罩挡住）', async ({ page }) => {
    await openAddModal(page);
    await page.locator('div.fixed.inset-0 button', { hasText: '金库凭据' }).click();
    await visible(page, 'input[placeholder*="Gemini"]').fill('锁定态凭据');
    await visible(page, 'input[placeholder*="粘贴完整"]').fill('sk-locked-secret');
    await page.locator('div.fixed.inset-0 button', { hasText: '保存资产' }).click();

    const password = page.locator('input[type="password"]').first();
    await expect(password).toBeVisible();

    // The unlock prompt must be the topmost element at its own centre point,
    // otherwise a real user's click lands on the modal underneath.
    const onTop = await password.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top === el;
    });
    expect(onTop, '解锁弹窗被 AddItemModal 遮挡').toBe(true);

    // And it must actually work end to end.
    const inputs = page.locator('input[type="password"]');
    await inputs.first().fill('new-pass-123');
    if ((await inputs.count()) > 1) await inputs.nth(1).fill('new-pass-123');
    await page.locator('button', { hasText: /完成设置并开启金库|立即解锁/ }).click();
    await expect(page.getByText('金库已解密')).toBeVisible();
  });

  test('“记住这台设备”刷新后仍然解锁（30 天免密）', async ({ page }) => {
    await setMasterPassword(page, 'remember-me-123');
    await expect(page.getByText('金库已解密')).toBeVisible();

    await page.reload();
    await expect(page.getByText('金库已解密')).toBeVisible({ timeout: 10_000 });
  });

  test('锁定金库会清除卡片上的明文', async ({ page }) => {
    await setMasterPassword(page, 'lock-me-123');
    await page.locator('button', { hasText: '新建凭据' }).first().click();
    await page.locator('div.fixed.inset-0 button', { hasText: '金库凭据' }).click();
    await visible(page, 'input[placeholder*="Gemini"]').fill('锁定测试');
    await visible(page, 'input[placeholder*="粘贴完整"]').fill('sk-plaintext-should-vanish');
    await page.locator('div.fixed.inset-0 button', { hasText: '保存资产' }).click();
    await expect.poll(async () => (await readState(page)).secrets.length).toBe(1);

    await page.locator('nav button', { hasText: '加密安全金库' }).click();
    await page.locator('button[title*="查看明文"]').first().click();
    await expect(page.locator('main')).toContainText('sk-plaintext-should-vanish');

    await page.locator('button', { hasText: '金库已解密' }).click();
    await expect(page.locator('main')).not.toContainText('sk-plaintext-should-vanish');
    await expect(page.getByText('金库锁定中')).toBeVisible();
  });
});

test.describe('备份与恢复', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
  });

  test('导入缺少可选字段的旧备份不会白屏', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.locator('aside button[title*="系统设置"]').click();
    await page.locator('[data-settings-nav="data"]').click();
    await page.setInputFiles('input[type="file"]', {
      name: 'partial-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(partialBackup), 'utf-8')
    });
    await page.waitForTimeout(1500);

    // The app must still be usable right after the import...
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('main')).toContainText('备份站点');
    expect(errors).toEqual([]);

    // ...and the restored state must be complete (defaults filled in).
    const state = await readState(page);
    expect(Array.isArray(state.checkIns)).toBe(true);
    expect(Array.isArray(state.handwritings)).toBe(true);
    expect(Array.isArray(state.categories)).toBe(true);

    await page.reload();
    await expect(page.locator('main')).toContainText('备份站点');
  });

  test('导出明文 JSON 备份可以下载', async ({ page }) => {
    await page.locator('aside button[title*="系统设置"]').click();
    await page.locator('[data-settings-nav="data"]').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button', { hasText: '导出明文' }).click()
    ]);
    expect(download.suggestedFilename()).toContain('self-hub-backup-v2');
  });

  test('重置所有数据会清空 IndexedDB（库名曾经写错）', async ({ page }) => {
    // Create data so IndexedDB is populated.
    await openAddModal(page);
    await visible(page, 'input[placeholder="例如: GitHub 个人中心"]').fill('IDB-标记');
    await visible(page, 'input[placeholder="https://..."]').fill('https://idb-marker.example.com');
    await page.locator('div.fixed.inset-0 button', { hasText: '保存资产' }).click();
    await page.waitForTimeout(2000);

    const before = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      return dbs.map((d) => d.name);
    });
    expect(before).toContain('self_hub_idb');

    await page.locator('aside button[title*="系统设置"]').click();
    await page.locator('[data-settings-nav="data"]').click();
    await page.locator('button', { hasText: '重置所有数据' }).click();
    await page.waitForTimeout(3500);

    const after = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const req = indexedDB.open('self_hub_idb');
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('sites')) return resolve([]);
            const all = db.transaction('sites', 'readonly').objectStore('sites').getAll();
            all.onsuccess = () => resolve(all.result.map((s: any) => s.title));
            all.onerror = () => resolve(['error']);
          };
          req.onerror = () => resolve(['open-error']);
        })
    );
    expect(after).not.toContain('IDB-标记');
  });
});

