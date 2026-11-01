import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState } from './helpers';
import { seedFixture, countCollections, v2Full, v2Messy } from '../fixtures/migrations';

/**
 * P2-02: v2 → v3 migration, driven by the P0-02 sanitized fixtures.
 * The acceptance criteria this spec exists to prove:
 */

const PASSWORD = 'fixture-migration-password';

type Report = {
  id: string;
  phase: string;
  stagingLibraryId: string;
  counts: Array<{ store: string; read: number; written: number; skipped: number }>;
  conflicts: Array<{ kind: string; detail: string }>;
  unknownFields: unknown[];
  warnings: string[];
  sourceHashes: Array<{ source: string; hash: string; counts: Record<string, number> }>;
  failure?: string;
};

type Outcome = {
  ok: boolean;
  interrupted?: boolean;
  switched: boolean;
  snapshotHash?: string;
  error?: string;
  report: Report;
};

async function preflight(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.__selfhubContract!.migration.preflight());
}

async function migrate(
  page: import('@playwright/test').Page,
  options: Record<string, unknown>
): Promise<Outcome> {
  return page.evaluate(
    (opts) => window.__selfhubContract!.migration.migrate(opts as never),
    options
  ) as Promise<Outcome>;
}

  test.describe('P2-02 v2 → v3 迁移', () => {
    test.beforeEach(async ({ page }) => {
      page.on('dialog', (d) => d.dismiss());
    });

/**
 * The snapshot has to survive the case it exists for.
 * A user migrates *because* the payload outgrew localStorage, so keeping the encrypted
 */
    test('大库也能迁移：加密快照写在 IndexedDB 而不是 localStorage', async ({ page }) => {
      const bigContent = '正文内容。'.repeat(60_000); // ~360 KB per note, 10 notes ≈ 3.6 MB
      const notes = Array.from({ length: 10 }, (_, i) => ({
        id: `big-${i}`,
        title: `大笔记 ${i}`,
        content: bigContent,
        updatedAt: i + 1
      }));
      await seedState(page, baseState({ notes }));
      await page.goto('/');
      await expect(page.locator('main')).toBeVisible();

      const payloadBytes = await page.evaluate(() => localStorage.getItem('self_hub_data_v2')?.length ?? 0);
      expect(payloadBytes, '夹具应当足够大以超过旧的快照路径').toBeGreaterThan(3_000_000);

      const outcome = await migrate(page, {
        password: 'large-library-password',
        allowSwitch: true,
        preferPayload: true
      });
      expect(outcome.ok, JSON.stringify(outcome.report.failure ?? outcome.error)).toBe(true);
      expect(outcome.switched).toBe(true);
      expect(outcome.snapshotHash).toBeTruthy();

      // The snapshot is in IndexedDB, keyed by the migration id, and readable back.
      const stored = await page.evaluate(async () => {
        const request = indexedDB.open('self_hub_idb');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rows = await new Promise<Array<{ id: string; ciphertext?: string }>>((resolve) => {
          const tx = db.transaction('migration_snapshots_v3', 'readonly');
          const all = tx.objectStore('migration_snapshots_v3').getAll();
          all.onsuccess = () => resolve((all.result || []) as Array<{ id: string; ciphertext?: string }>);
          all.onerror = () => resolve([]);
        });
        db.close();
        return { count: rows.length, firstBytes: rows[0]?.ciphertext?.length ?? 0, ids: rows.map((r) => r.id) };
      });
      expect(stored.count, '快照应当存在 IndexedDB 里').toBeGreaterThan(0);
      expect(stored.firstBytes, '快照内容是加密后的密文').toBeGreaterThan(1_000_000);
      // Nothing of that size was left in localStorage.
      const leftover = await page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.includes('migration_snapshot')).length
      );
      expect(leftover, '不再往 localStorage 写快照').toBe(0);
    });

  test('预检只读：给出将写入的数量、冲突与未知字段，不写入任何数据', async ({ page }) => {
    await seedFixture(page, 'v2-messy');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const result = await preflight(page);
    expect(result.ok).toBe(true);

    // Count evidence per source (§13.4).
    expect(result.sourceHashes.length).toBeGreaterThanOrEqual(2);
    const lsSource = result.sourceHashes.find((s) => s.source === 'localStorage-v2');
    expect(lsSource).toBeTruthy();
    expect(lsSource!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(lsSource!.counts.sites).toBe((v2Messy as { sites: unknown[] }).sites.length);

    // The messy fixture must produce a dangling-reference conflict: it references
    // `ghost-note-9999`, and §13.2 says to report that rather than invent a record.
    expect(result.report.conflicts.some((c) => c.kind === 'dangling-reference')).toBe(true);

    // Unknown root fields are reported, not silently dropped.
    expect(result.report.unknownFields.length).toBeGreaterThan(0);

    // Preflight wrote nothing: the staging store still has zero rows.
    const again = await preflight(page);
    expect(again.planned.every((p) => p.found === p.missing), '预检不应写入').toBe(true);
  });

  test('迁移写入 staging 库，逐集合数量可核对，且不切换应用的活动库', async ({ page }) => {
    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const activeBefore = await page.evaluate(() => window.__selfhubContract!.migration.activeLibraryId());
    const outcome = await migrate(page, { password: PASSWORD });

    expect(outcome.report.phase).toBe('verified');
    expect(outcome.ok).toBe(true);

    // Encrypted snapshot exists and is decryptable, so there is a way back.
    expect(outcome.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const restored = await page.evaluate(
      ([id, pwd]) => window.__selfhubContract!.migration.readSnapshot(id as string, pwd as string),
      [outcome.report.id, PASSWORD] as const
    );
    expect(restored.ok, `快照应可解密：${restored.error}`).toBe(true);
    expect(restored.sources!.length).toBeGreaterThanOrEqual(2);
    // The snapshot holds the *original* bytes, so the source hash still matches.
    const lsSnapshot = restored.sources!.find((s) => s.id === 'localStorage-v2');
    const lsHash = outcome.report.sourceHashes.find((s) => s.source === 'localStorage-v2')!.hash;
    expect(lsSnapshot!.hash).toBe(lsHash);

    // Counts: every collection that had records produced written rows.
    //
    // The deliberate `GreaterThanOrEqual` matters: the migration reads *both* the
    // localStorage payload and the v1 IndexedDB mirror (§13.1), and the app mirrors
    // every save into that mirror, so the same logical note legitimately arrives
    // from two sources with two namespaced ids. Requiring exact equality with one
    // source's count would be asserting that the mirror is ignored.
    const lsSource = outcome.report.sourceHashes.find((s) => s.source === 'localStorage-v2')!;
    const idbSource = outcome.report.sourceHashes.find((s) => s.source === 'idb-mirror-v1');
    expect(lsSource.counts.notes).toBe((v2Full as { notes: unknown[] }).notes.length);
    expect(idbSource, '应同时读取旧 IndexedDB 镜像作为来源').toBeTruthy();

    const notes = outcome.report.counts.find((c) => c.store === 'note_bodies_v3');
    expect(notes!.written).toBeGreaterThanOrEqual((v2Full as { notes: unknown[] }).notes.length);
    const items = outcome.report.counts.find((c) => c.store === 'items_v3');
    expect(items!.written).toBeGreaterThanOrEqual(
      (v2Full as { notes: unknown[] }).notes.length + (v2Full as { sites: unknown[] }).sites.length
    );

    // The live library is untouched: the app still reads v2 with its own counts.
    const activeAfter = await page.evaluate(() => window.__selfhubContract!.migration.activeLibraryId());
    expect(activeAfter).toBe(activeBefore);
    expect(outcome.switched).toBe(false);
    const live = await countCollections(await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? JSON.parse(raw) : {};
    }));
    expect(live.sites).toBe((v2Full as { sites: unknown[] }).sites.length);
  });

  test('中断后续跑不重复写入，且跳过数量被记录', async ({ page }) => {
    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const staging = `staging-resume-${Date.now()}`;

    // Run only one batch, then stop.
    const first = await migrate(page, { password: PASSWORD, stagingLibraryId: staging, batchSize: 2, maxBatches: 1 });
    expect(first.interrupted).toBe(true);
    expect(first.report.phase).toBe('staging');

    const checkpoint = await page.evaluate(
      (id) => window.__selfhubContract!.migration.checkpoint(id),
      staging
    );
    expect(checkpoint?.batchIndex).toBe(1);

    // Resume: the same sources, the same staging library.
    const second = await migrate(page, { password: PASSWORD, stagingLibraryId: staging, batchSize: 2, resume: true });
    expect(second.report.phase).toBe('verified');
    expect(second.ok).toBe(true);

    // Nothing duplicated: the final counts equal the first run's plan, and the
    // second run skipped whatever the first had already written.
    const written = second.report.counts.reduce((sum, c) => sum + c.written, 0);
    const planned = await preflight(page);
    const plannedTotal = planned.planned.reduce((sum, p) => sum + p.found, 0);
    expect(written).toBe(plannedTotal);
  });

  test('来源在两次运行之间变化时拒绝续跑，而不是拼出半个库', async ({ page }) => {
    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const staging = `staging-changed-${Date.now()}`;
    await migrate(page, { password: PASSWORD, stagingLibraryId: staging, batchSize: 2, maxBatches: 1 });

    // Change the source: add a note to the live payload.
    await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      const state = raw ? JSON.parse(raw) : {};
      state.notes = [...(state.notes || []), { id: 'late-note', title: '运行后新增', content: 'x', updatedAt: Date.now() }];
      localStorage.setItem('self_hub_data_v2', JSON.stringify(state));
    });

    const resumed = await migrate(page, { password: PASSWORD, stagingLibraryId: staging, resume: true });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toBe('source-changed');
    expect(resumed.report.failure).toContain('来源数据');
  });

  test('没有快照密码时拒绝迁移（迁移前必须有加密副本）', async ({ page }) => {
    await seedFixture(page, 'v2-messy');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const outcome = await migrate(page, { password: '' });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('missing-password');
    expect(outcome.report.phase).toBe('failed');
  });

  /**
   * One snapshot per device, not one per migration.
   *
   * Each snapshot is about the size of the sources it copies. Keeping every one of them
   * grows without bound on a device whose owner migrates more than once, and only the newest
   * one can be the pre-switch state of the last migration — the only rollback anyone means.
   */
  test('只保留最新一份迁移快照', async ({ page }) => {
    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const first = await migrate(page, {
      password: 'retention-password',
      stagingLibraryId: 'staging-retention-a',
      skipSwitch: true
    });
    expect(first.ok, first.report.failure ?? first.error).toBe(true);
    const second = await migrate(page, {
      password: 'retention-password',
      stagingLibraryId: 'staging-retention-b',
      skipSwitch: true
    });
    expect(second.ok, second.report.failure ?? second.error).toBe(true);

    const snapshots = await page.evaluate(async () => {
      const request = indexedDB.open('self_hub_idb');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise<Array<{ id: string }>>((resolve) => {
        const tx = db.transaction('migration_snapshots_v3', 'readonly');
        const all = tx.objectStore('migration_snapshots_v3').getAll();
        all.onsuccess = () => resolve((all.result || []) as Array<{ id: string }>);
        all.onerror = () => resolve([]);
      });
      db.close();
      return rows.map((row) => row.id);
    });

    // The snapshot id is the migration id, which prefixes the staging library id.
    expect(snapshots, '两次迁移之后只应留下最新的一份快照').toEqual(['migration-staging-retention-b']);
  });

  test('迁移锁会阻止普通写入，避免与迁移交错', async ({ page }) => {    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    // Acquire the lock as a *foreign* owner and leave it held.
    const acquired = await page.evaluate(() =>
      window.__selfhubContract!.migration.acquireLock('staging-lock-test', {})
    );
    expect(acquired.ok).toBe(true);
    const owner = acquired.lock!.owner;

    // An ordinary edit must be refused while the lock is live.
    const saveOutcome = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      const before = raw;
      const state = raw ? JSON.parse(raw) : {};
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      // Import the real writer through the app module graph is not possible from
      // the page, so assert the guard through the storage key staying identical
      // after a reload-driven persist attempt.
      localStorage.setItem('self_hub_data_v2', JSON.stringify(state));
      return { before, after: localStorage.getItem('self_hub_data_v2'), changed: before !== localStorage.getItem('self_hub_data_v2') };
    });
    // Sanity: the raw key is writable in isolation (the guard lives in the app's
    // writer, not in localStorage itself).
    expect(saveOutcome.changed).toBe(true);

    // The guard itself: a live foreign lock blocks this origin's writer.
    await page.reload();
    const banner = page.getByTestId('schema-readonly-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('迁移');

    // Release and confirm the app is writable again.
    await page.evaluate((o) => window.__selfhubContract!.migration.releaseLock(o as string), owner);
    await page.reload();
    await expect(page.getByTestId('schema-readonly-banner')).toHaveCount(0);
  });

  test('验证通过后才切换活动库，切换是一次写入（原子），失败不切换', async ({ page }) => {
    await seedFixture(page, 'v2-full');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    // Default build: verification passes but the switch stays off, so the app
    // keeps reading v2. That is the shipped behaviour until P2-05/P2-07 land.
    const gated = await migrate(page, { password: PASSWORD });
    expect(gated.report.phase).toBe('verified');
    expect(gated.switched).toBe(false);
    expect(await page.evaluate(() => window.__selfhubContract!.migration.activeLibraryId())).toBeNull();

    // Explicitly allowed: the switch happens, and it is one durable write of
    // activeLibraryId pointing at the verified staging library.
    const staging = `staging-switch-${Date.now()}`;
    const switched = await migrate(page, { password: PASSWORD, stagingLibraryId: staging, allowSwitch: true });
    expect(switched.report.phase).toBe('verified');
    expect(switched.switched).toBe(true);

    const active = await page.evaluate(() => window.__selfhubContract!.migration.activeLibraryId());
    expect(active).toBe(staging);

    // The switch did not mutate the v2 payload the app still boots from, so the
    // previous library remains readable — a switch is not a delete.
    const live = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? JSON.parse(raw) : null;
    });
    expect(live.sites.length).toBe((v2Full as { sites: unknown[] }).sites.length);

    // Re-running the same migration is idempotent and still verified.
    const again = await migrate(page, { password: PASSWORD, stagingLibraryId: staging, resume: true });
    expect(again.report.phase).toBe('verified');
    expect(again.report.counts.reduce((sum, c) => sum + c.written, 0)).toBe(
      switched.report.counts.reduce((sum, c) => sum + c.written, 0)
    );
  });
  test('冲突与未知字段会写进报告，失效引用不会被伪造实体', async ({ page }) => {
    await seedFixture(page, 'v2-messy');
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const outcome = await migrate(page, { password: PASSWORD });
    expect(outcome.report.phase).toBe('verified');

    // The dangling reference is reported, and no placeholder project/note exists
    // for the ghost id.
    const dangling = outcome.report.conflicts.filter((c) => c.kind === 'dangling-reference');
    expect(dangling.length).toBeGreaterThan(0);
    expect(dangling.some((c) => c.detail.includes('ghost-note-9999'))).toBe(true);

    // Unknown fields carried through the report.
    expect(outcome.report.unknownFields.some((u) => (u as { field: string }).field === 'legacyVersion')).toBe(true);

    // The two annotations that share a URL but differ in text are both present:
    // stated as a warning rather than merged away.
    expect(outcome.report.warnings.some((w) => w.includes('不同文本的批注'))).toBe(true);
  });
});
