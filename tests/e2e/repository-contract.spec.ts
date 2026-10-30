import { test, expect } from '@playwright/test';
import { resetApp } from './helpers';

/**
 * P2-01: the shared repository contract, run against **both** implementations.
 *
 * The suite itself lives in `src/repositories/contractSuite.ts` and only uses the
 * `HubRepository` surface, so a divergence between the legacy payload and the v3
 * IndexedDB store shows up as a failing check rather than as a difference between
 * two hand-written test files.
 *
 * The suite is driven through the dev-only bridge (`src/app/devBridge.ts`), which
 * is guarded by `import.meta.env.DEV` and therefore absent from a production
 * build. Running it in a real browser is deliberate: IndexedDB cannot be
 * meaningfully exercised without one, and the point of P2-01 is that the
 * transaction guarantees hold for real.
 */

type CheckResult = { name: string; ok: boolean; detail?: string };

async function runSuite(page: import('@playwright/test').Page, kind: 'legacy' | 'indexeddb', runId: string) {
  const results = await page.evaluate(
    ([k, id]) => window.__selfhubContract!.run(k as 'legacy' | 'indexeddb', id as string),
    [kind, runId] as const
  );
  return results as CheckResult[];
}

function summarise(results: CheckResult[]): string {
  const failed = results.filter((r) => !r.ok);
  return failed.map((r) => `${r.name} → ${r.detail}`).join('\n');
}

test.describe('P2-01 仓库契约', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('v3 schema 建齐所有 _v3 集合与旧集合共存', async ({ page }) => {
    await resetApp(page);
    const schema = await page.evaluate(() => window.__selfhubContract!.schema());

    expect(schema.version).toBeGreaterThanOrEqual(2);
    // Every declared store must exist after the upgrade.
    expect(schema.missingV3Stores, `缺少集合: ${schema.missingV3Stores.join(', ')}`).toEqual([]);
    expect(schema.v3Stores.length).toBeGreaterThanOrEqual(23);

    // The v1 mirror stores must survive: they are the fallback read path until
    // the migration has been proven (dev doc §6.4 / §13.4).
    expect(schema.legacyStores).toContain('notes');
    expect(schema.legacyStores).toContain('sites');
    expect(schema.legacyStores).toContain('blobs');
  });

  test('Legacy 实现满足全部契约检查', async ({ page }) => {
    await resetApp(page);
    const results = await runSuite(page, 'legacy', `legacy${Date.now()}`);
    expect(results.length).toBeGreaterThan(10);
    expect(results.filter((r) => !r.ok), summarise(results)).toEqual([]);
  });

  test('IndexedDB 实现满足全部契约检查', async ({ page }) => {
    await resetApp(page);
    const results = await runSuite(page, 'indexeddb', `idb${Date.now()}`);
    expect(results.length).toBeGreaterThan(10);
    expect(results.filter((r) => !r.ok), summarise(results)).toEqual([]);
  });

  test('两个实现通过同一组、数量一致的检查', async ({ page }) => {
    await resetApp(page);
    const stamp = Date.now();
    const legacy = await runSuite(page, 'legacy', `parity-l-${stamp}`);
    const idb = await runSuite(page, 'indexeddb', `parity-i-${stamp}`);

    // Same list, same order: the suite is not branching on the implementation.
    expect(legacy.map((r) => r.name)).toEqual(idb.map((r) => r.name));
    expect(legacy.filter((r) => !r.ok), `legacy 失败:\n${summarise(legacy)}`).toEqual([]);
    expect(idb.filter((r) => !r.ok), `indexeddb 失败:\n${summarise(idb)}`).toEqual([]);
  });

  test('被拒绝的写入不会留下半条记录，也不会改变内容版本', async ({ page }) => {
    // Spelled out as its own test because it is the P2-01 acceptance criterion,
    // not just one check among many.
    await resetApp(page);
    const outcome = await page.evaluate(async () => {
      const bridge = window.__selfhubContract!;
      const runId = `atomic${Date.now()}`;
      // The suite's "引用不存在的项目" check is exactly this scenario; re-run the
      // whole suite for both implementations and surface only that check so the
      // assertion below is unambiguous.
      const legacy = await bridge.run('legacy', runId);
      const idb = await bridge.run('indexeddb', runId);
      const pick = (rs: Array<{ name: string; ok: boolean; detail?: string }>) =>
        rs.find((r) => r.name.includes('不留下半条记录'));
      return { legacy: pick(legacy), idb: pick(idb) };
    });

    expect(outcome.legacy?.ok, `legacy: ${outcome.legacy?.detail}`).toBe(true);
    expect(outcome.idb?.ok, `indexeddb: ${outcome.idb?.detail}`).toBe(true);
  });
});
