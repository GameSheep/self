import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, openSettings, gotoSettingsPane } from './helpers';
import { mockOss } from './ossMock';

/**
 * P2 切库: the storage-mode switch.
 *
 * The switch changes *where the app reads its data from*, which is the most dangerous
 * change in the whole redesign — getting it wrong means showing the wrong library or
 * silently overwriting the newer one. So this spec pins, in order:
 *
 * 1. the default is unchanged (v2), so nothing moves for anyone who does not switch;
 * 2. switching runs the verified migration (encrypted snapshot → staging library →
 *    verification → atomic `activeLibraryId` flip) and the app follows that pointer;
 * 3. in v3 mode edits reach the library and the payload shrinks to device configuration;
 * 4. a reload reads v3 and does **not** let a stale v2 payload overwrite it;
 * 5. switching back materialises the payload from the library.
 */

function state(overrides: Record<string, unknown> = {}) {
  return baseState({
    notes: [{ id: 'n1', title: '切换前的笔记', content: '# 正文', updatedAt: 1 }],
    sites: [{ id: 's1', title: '站点', url: 'https://example.com', category: '工具', createdAt: 1 }],
    inbox: [],
    ...overrides
  });
}

async function openStoragePane(page: any) {
  await openSettings(page);
  await gotoSettingsPane(page, 'storage');
  await expect(page.getByTestId('storage-mode')).toBeVisible();
}

/** The library the app is actually reading (`library_meta_v3.activeLibraryId`). */
async function activeLibraryId(page: any): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const request = indexedDB.open('self_hub_idb');
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('library_meta_v3')) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction('library_meta_v3', 'readonly');
          const get = tx.objectStore('library_meta_v3').get('activeLibraryId');
          get.onsuccess = () => {
            resolve((get.result as { value?: string } | undefined)?.value ?? null);
            db.close();
          };
          get.onerror = () => {
            resolve(null);
            db.close();
          };
        };
        request.onerror = () => resolve(null);
      })
  );
}

async function libraryCounts(page: any, libraryId?: string): Promise<Record<string, number> | undefined> {
  const id = libraryId ?? (await activeLibraryId(page)) ?? 'local-v2';
  const loaded = await page.evaluate((target) => window.__selfhubContract!.library.load(target), id);
  return loaded.ok ? (loaded.counts as Record<string, number>) : undefined;
}

/**
 * Run the switch-to-v3 flow: the migration needs the snapshot password, and the button is
 * only pressed after the field is filled.
 */
async function switchToV3(page: any, password = 'test-migration-password') {
  await page.getByTestId('storage-migration-password').fill(password);
  await page.getByTestId('storage-mode-switch-v3').click();
  await expect(page.getByTestId('storage-mode-current')).toHaveText('v3', { timeout: 20_000 });
}

test.describe('P2 存储模式切换', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
  });

  test('默认仍是 v2：改动只写 v2，v3 库不被读写', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);
    await expect(page.getByTestId('storage-mode-current')).toHaveText('local');

    // An edit in local mode must not touch the library.
    // Settings is a separate route: go back to the home page before capturing.
    await page.goto('/#/home');
    await page.getByTestId('home-capture-input').fill('本地模式记录');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');
    const stored = await page.evaluate(() => localStorage.getItem('self_hub_data_v2'));
    expect(stored).toContain('本地模式记录');

    const counts = await libraryCounts(page);
    expect(counts?.notes ?? 0).toBe(0);
    expect(counts?.inbox ?? 0).toBe(0);
  });

  test('切换到 v3 会先写入资料再改变读取来源，且 v2 仍保留为回退副本', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);

    await switchToV3(page);
    await expect(page.getByTestId('storage-mode-counts')).toContainText('笔记 1');

    // The library holds the data…
    const counts = await libraryCounts(page);
    expect(counts?.notes).toBe(1);
    expect(counts?.sites).toBe(1);
    // …and switching back stays possible: the pre-switch payload was snapshotted.
    // (The live payload is device-only in v3 mode by design — see the capacity test.)
    const rollback = await page.evaluate(() => localStorage.getItem('selfhub_v2_rollback'));
    expect(rollback).toContain('切换前的笔记');
    const payloadNotes = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? (JSON.parse(raw).notes?.length ?? -1) : -1;
    });
    expect(payloadNotes).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('selfhub_storage_mode'))).toBe('v3');
  });

  test('v3 模式下改动进入 v3 库，同时仍写 v2', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);
    await switchToV3(page);

    // Settings is a separate route: go back to the home page before capturing.

    await page.goto('/#/home');

    await page.getByTestId('home-capture-input').fill('进入 v3 的记录');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // The write is debounced (800ms), so poll instead of sleeping a fixed time.
    await expect
      .poll(async () => (await libraryCounts(page))?.inbox ?? 0, { timeout: 10_000 })
      .toBe(1);
    // The live payload is device-only in v3 mode: the record lives in the library,
    // and the rollback snapshot predates it (it is taken once, at switch time).
    const payloadNotes = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? (JSON.parse(raw).inbox?.length ?? -1) : -1;
    });
    expect(payloadNotes).toBe(0);
  });

  test('刷新后从 v3 读取，过期的 v2 负载不会覆盖它', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);
    await switchToV3(page);

    // Add something that exists only in the library.
    // Settings is a separate route: go back to the home page before capturing.
    await page.goto('/#/home');
    await page.getByTestId('home-capture-input').fill('只在 v3 里的记录');
    await page.getByTestId('home-capture-submit').click();
    await expect.poll(async () => (await libraryCounts(page))?.inbox ?? 0, { timeout: 10_000 }).toBe(1);

    // Simulate an old tab / stale payload that predates the library write.
    await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      const stale = raw ? JSON.parse(raw) : {};
      stale.inbox = [];
      stale.notes = [{ id: 'n1', title: '过期的 v2 笔记', content: '旧内容', updatedAt: 1 }];
      localStorage.setItem('self_hub_data_v2', JSON.stringify(stale));
    });
    await page.reload();

    // The app must show the library, not the stale payload…
    await expect(page.getByTestId('home-view')).toBeVisible();
    await expect
      .poll(async () => (await libraryCounts(page))?.inbox ?? 0, { timeout: 10_000 })
      .toBe(1);
    await expect(page.locator('main')).not.toContainText('过期的 v2 笔记');
    // …and it must not have pushed the stale payload into the library.
    const notes = await page.evaluate(async () => {
      const loaded = await window.__selfhubContract!.library.load('local-v2');
      return (loaded.state as any)?.notes?.map((note: any) => note.title) ?? [];
    });
    expect(notes).not.toContain('过期的 v2 笔记');
  });

  /**
   * The switch is a multi-second operation behind a plain button.
   *
   * A second click while the first migration is running must not start another one — and,
   * just as important, must not leave a scary error on screen for a switch that succeeded.
   */
  test('连点「迁移并切换」不会启动第二次迁移，也不会留下错误提示', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);

    await page.getByTestId('storage-migration-password').fill('double-click-password');
    const switchButton = page.getByTestId('storage-mode-switch-v3');
    // Two clicks in quick succession, without waiting for the first to settle.
    await switchButton.click();
    await switchButton.click({ force: true, timeout: 2000 }).catch(() => undefined);

    await expect(page.getByTestId('storage-mode-current')).toHaveText('v3', { timeout: 30_000 });
    await expect(page.getByTestId('storage-migration-error')).toHaveCount(0);
    // The data really moved, so this is a completed switch and not just a flipped label.
    const counts = await libraryCounts(page);
    expect(counts?.notes).toBe(1);

    // And exactly one migration ran: the runner records a report per run.
    const reports = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const request = indexedDB.open('self_hub_idb');
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('migrations_v3')) {
              db.close();
              resolve([]);
              return;
            }
            const tx = db.transaction('migrations_v3', 'readonly');
            const all = tx.objectStore('migrations_v3').getAll();
            all.onsuccess = () => {
              resolve(((all.result || []) as Array<{ id: string }>).map((row) => row.id));
              db.close();
            };
            all.onerror = () => {
              resolve([]);
              db.close();
            };
          };
          request.onerror = () => resolve([]);
        })
    );
    expect(reports.length, `迁移报告数量：${reports.join(', ')}`).toBe(1);
  });

  test('新装档案（没有任何数据）也能切到 v3，且不留错误', async ({ page }) => {
    // A brand-new profile: `resetApp` clears storage, so the payload is the app's own
    // fresh install state. This is what "switch to v3 right after installing" looks like —
    // the migration has to cope with an empty library, not assume there is data.
    await page.goto('/');
    await openStoragePane(page);

    await page.getByTestId('storage-migration-password').fill('fresh-profile-password');
    await page.getByTestId('storage-mode-switch-v3').click();

    await expect(page.getByTestId('storage-mode-current')).toHaveText('v3', { timeout: 30_000 });
    await expect(page.getByTestId('storage-migration-error')).toHaveCount(0);
    // An empty library is empty, and the app says so rather than inventing content.
    await expect(page.getByTestId('storage-mode-counts')).toBeVisible();
    // The app still works: a capture lands in the library.
    await page.goto('/#/home');
    await page.getByTestId('home-capture-input').fill('新装之后的第一条');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');
    await expect.poll(async () => (await libraryCounts(page))?.inbox ?? 0, { timeout: 10_000 }).toBe(1);
  });

  test('连点「切回 v2 负载」也只切一次，负载完整', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);
    await switchToV3(page);

    const back = page.getByTestId('storage-mode-switch-local');
    await back.click();
    await back.click({ force: true, timeout: 2000 }).catch(() => undefined);

    await expect(page.getByTestId('storage-mode-current')).toHaveText('local', { timeout: 20_000 });
    // The payload was materialised from the library, with the data intact.
    const payload = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? (JSON.parse(raw).notes as Array<{ title?: string }> | undefined)?.length ?? -1 : -1;
    });
    expect(payload).toBe(1);
    await expect(page.getByTestId('storage-mode-error')).toHaveCount(0);
  });

  test('切回 v2 后重新以 v2 为事实来源，不再写 v3', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);
    await switchToV3(page);

    await page.getByTestId('storage-mode-switch-local').click();
    await expect(page.getByTestId('storage-mode-current')).toHaveText('local');
    expect(await page.evaluate(() => localStorage.getItem('selfhub_storage_mode'))).toBeNull();

    // A new edit lands in v2 and not in the library (which kept its snapshot).
    // Settings is a separate route: go back to the home page before capturing.
    await page.goto('/#/home');
    await page.getByTestId('home-capture-input').fill('切回后的记录');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');
    const payload = await page.evaluate(() => localStorage.getItem('self_hub_data_v2'));
    expect(payload).toContain('切回后的记录');

    const counts = await libraryCounts(page);
    expect(counts?.inbox ?? 0).toBe(0);
  });

  test('v3 模式下 v2 负载只剩设备配置：整包大小不再随资料增长', async ({ page }) => {
    // 200 notes of roughly 2 KB: the old single-payload design would be hundreds of KB.
    // The point of the switch is that this stops mattering.
    const bigNotes = Array.from({ length: 200 }, (_, i) => ({
      id: `n${i}`,
      title: `笔记 ${i}`,
      content: `${'正文内容。'.repeat(300)}#${i}`,
      updatedAt: i + 1
    }));
    await seedState(page, state({ notes: bigNotes }));
    await page.goto('/');

    const before = await page.evaluate(() => localStorage.getItem('self_hub_data_v2')?.length ?? 0);
    expect(before).toBeGreaterThan(300_000);

    await openStoragePane(page);
    await switchToV3(page);

    // Trigger one save in v3 mode (this is the write that becomes device-only).
    await page.goto('/#/home');
    await page.getByTestId('home-capture-input').fill('触发一次保存');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    const after = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return { bytes: raw?.length ?? 0, notes: raw ? (JSON.parse(raw).notes?.length ?? -1) : -1 };
    });
    // Business data is no longer in the payload…
    expect(after.notes).toBe(0);
    // …so it no longer grows with the library.
    expect(after.bytes).toBeLessThan(100_000);
    // The library still holds everything.
    expect((await libraryCounts(page))?.notes).toBe(200);
    // The pre-switch payload is kept once as a rollback copy.
    const rollback = await page.evaluate(() => localStorage.getItem('selfhub_v2_rollback')?.length ?? 0);
    expect(rollback).toBeGreaterThan(300_000);
  });

  test('库被清空时启动会从回滚快照恢复，切回 v2 会重新物化负载', async ({ page }) => {
    await seedState(page, state());
    await page.goto('/');
    await openStoragePane(page);
    await switchToV3(page);

    // Clear the library's business stores to simulate a lost / unreadable v3 库.
    await page.evaluate(async () => {
      const stores = [
        'items_v3',
        'note_bodies_v3',
        'bookmarks_v3',
        'webpages_v3',
        'annotations_v3',
        'inbox_v3',
        'projects_v3',
        'entity_links_v3',
        'servers_v3',
        'credentials_v3',
        'reminders_v3',
        'checkins_v3',
        'checkin_runs_v3',
        'remote_documents_v3',
        'blobs_v3',
        'attachments_v3',
        'settings_v3'
      ];
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('self_hub_idb');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction(stores, 'readwrite');
        for (const store of stores) tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
      db.close();
    });

    await page.reload();
    // Restored from the pre-switch snapshot rather than showing an empty app.
    await expect(page.getByTestId('v3-write-error')).toContainText('v2 快照', { timeout: 10_000 });
    // The reload restored the settings route, so go look at the data itself.
    await page.goto('/#/library');
    await expect(page.locator('main')).toContainText('切换前的笔记');

    // Switching back materialises the payload again.
    await openStoragePane(page);
    await page.getByTestId('storage-mode-switch-local').click();
    await expect(page.getByTestId('storage-mode-current')).toHaveText('local');
    const notes = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? (JSON.parse(raw).notes?.length ?? -1) : -1;
    });
    expect(notes).toBe(1);
  });

  /**
   * After a migration the app reads a *different* library, so everything else must follow.
   *
   * The v3 backup service used to default to the pre-migration `local-v2` id. After a
   * switch that meant the backup captured the **old** library while the user kept editing
   * the new one — a backup that exists, looks fine, and does not contain their data.
   */
  test('切换之后 v3 备份写的是当前活动库，而不是迁移前的库', async ({ page }) => {
    const bucket = 'selfhub-bucket';
    const endpoint = 'oss-cn-hangzhou.aliyuncs.com';
    const remote = await mockOss(page, { bucket, endpoint });

    await seedState(
      page,
      state({
        obsidianConfig: {
          enabled: true,
          bucket,
          endpoint,
          region: 'oss-cn-hangzhou',
          accessKeyId: 'test-key-id',
          accessKeySecret: 'test-key-secret',
          prefix: 'selfhub/'
        },
        backupPolicy: { provider: 'oss', enabled: true, format: 'v3' }
      })
    );
    await page.goto('/');
    await openStoragePane(page);

    // 1. Switch to the migrated library; the app follows `activeLibraryId` from here.
    await switchToV3(page);
    const migratedLibrary = await activeLibraryId(page);
    expect(migratedLibrary, '迁移应写入活动库指针').toBeTruthy();
    expect(migratedLibrary).not.toBe('local-v2');

    // 2. Run a real v3 backup against the mocked bucket.
    await page.getByTestId('v3-password-input').fill('backup-password-123');
    await page.getByTestId('v3-unlock').click();
    await page.getByTestId('v3-run').click();
    await expect(page.getByTestId('v3-message')).toContainText('备份完成', { timeout: 20_000 });

    // 3. What was actually uploaded: paths carry the library segment.
    const puts = remote.captured.filter((entry) => entry.method === 'PUT').map((entry) => entry.path);
    expect(puts.length, '备份应当上传对象').toBeGreaterThan(0);
    expect(
      puts.some((path) => path.includes(migratedLibrary as string)),
      `备份路径应包含活动库 ${migratedLibrary}：${puts.slice(0, 3).join(', ')}`
    ).toBe(true);
    expect(
      puts.filter((path) => path.includes('local-v2')),
      '备份不应再写向迁移前的库'
    ).toEqual([]);
  });

  /**
   * The mirror image of the backup bug: restoring into the wrong place.
   *
   * In v3 mode the payload holds only device configuration, so a *legacy* import written
   * there looks like "the restore did nothing" — the app reads the library, and the library
   * still holds the old records. The imported data has to land in the active library.
   */
  test('v3 模式下导入旧格式备份会写进活动库，并保留本机连接', async ({ page }) => {
    const plaintextBackup = JSON.stringify({
      schemaVersion: 2,
      theme: 'dark',
      categories: ['技术开发'],
      sites: [{ id: 'imported-site', title: '导入的站点', url: 'https://imported.example.com', category: '技术开发', createdAt: 1 }],
      servers: [],
      secrets: [],
      reminders: [],
      checkIns: [],
      handwritings: [],
      inbox: [],
      projects: [],
      annotations: [],
      notes: [
        { id: 'imported-note-1', title: '导入的笔记一', content: '# 一', updatedAt: 1 },
        { id: 'imported-note-2', title: '导入的笔记二', content: '# 二', updatedAt: 2 }
      ],
      // A connection inside the package: it must NOT replace this device's own.
      obsidianConfig: {
        enabled: true,
        bucket: 'from-the-backup',
        endpoint: 'oss-cn-beijing.aliyuncs.com',
        region: 'cn-beijing',
        accessKeyId: 'BACKUP-KEY',
        accessKeySecret: 'BACKUP-SECRET',
        prefix: 'vault/'
      }
    });

    await seedState(
      page,
      state({
        obsidianConfig: {
          enabled: true,
          bucket: 'device-bucket',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          region: 'cn-hangzhou',
          accessKeyId: 'DEVICE-KEY',
          accessKeySecret: 'DEVICE-SECRET',
          prefix: 'vault/'
        }
      })
    );
    await page.goto('/');
    await openStoragePane(page);
    await switchToV3(page);
    const migratedLibrary = await activeLibraryId(page);

    // Import the legacy package while the app is reading the v3 library.
    await page.goto('/#/settings/data');
    await expect(page.locator('[data-testid="import-backup-file"]')).toHaveCount(1);
    await page.setInputFiles('[data-testid="import-backup-file"]', {
      name: 'legacy-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(plaintextBackup, 'utf8')
    });

    // The data is really in the active library…
    await expect
      .poll(
        async () => {
          const loaded = await page.evaluate(
            (id) => window.__selfhubContract!.library.load(id),
            migratedLibrary as string
          );
          const state = (loaded.state as { notes?: Array<{ title?: string }> }) ?? {};
          return (state.notes ?? []).map((note) => note.title).join(',');
        },
        { timeout: 20_000, message: '导入的数据应写入活动库' }
      )
      .toContain('导入的笔记一');

    // …and the app shows it (the point of the fix: the restore is not a no-op).
    await page.goto('/#/library');
    await expect(page.locator('main')).toContainText('导入的笔记一');

    // The package's connection did not overwrite this device's own.
    const deviceConfig = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      const state = raw ? JSON.parse(raw) : {};
      return { bucket: state.obsidianConfig?.bucket, key: state.obsidianConfig?.accessKeyId };
    });
    expect(deviceConfig.bucket).toBe('device-bucket');
    expect(deviceConfig.key).toBe('DEVICE-KEY');
  });
});
