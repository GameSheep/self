import { test, expect } from '@playwright/test';
import { resetApp } from './helpers';

/**
 * P2-05: durable job queue.
 * The queue exists because a backup that only lives in a `setTimeout` inside an
 */

type CheckResult = { name: string; ok: boolean; detail?: string };

function summarise(results: CheckResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `${r.name} → ${r.detail}`)
    .join('\n');
}

test.describe('P2-05 持久任务队列', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
    await resetApp(page);
  });

  test('任务队列语义自检全部通过', async ({ page }) => {
    const results = (await page.evaluate(() =>
      window.__selfhubContract!.jobs.run(`suite${Date.now()}`)
    )) as CheckResult[];

    expect(results.length).toBeGreaterThanOrEqual(13);
    expect(results.filter((r) => !r.ok), `失败项:\n${summarise(results)}`).toEqual([]);
  });

  test('排队任务在页面重载后仍可被重新认领', async ({ page }) => {
    const libraryId = `jobs-reload-${Date.now()}`;

    const enqueued = await page.evaluate(
      ([lib, runId]) => window.__selfhubContract!.jobs.enqueue(lib as string, { kind: 'backup', scopeKey: `${runId}-scope` }),
      [libraryId, 'reload'] as const
    );
    expect(enqueued.ok, JSON.stringify(enqueued.error)).toBe(true);
    expect(enqueued.created).toBe(true);

    // A real reload: new window, new JS context, new module instances.
    await page.reload();
    await expect(page.locator('main')).toBeVisible();

    const claimed = await page.evaluate(
      ([lib, owner]) => window.__selfhubContract!.jobs.claim(lib as string, owner as string),
      [libraryId, 'worker-after-reload'] as const
    );
    expect(claimed.ok, JSON.stringify(claimed.error)).toBe(true);
    expect(claimed.job?.id).toBe(enqueued.id);
    expect(claimed.job?.state).toBe('running');
    expect(claimed.job?.attempt).toBe(1);

    // The lease belongs to the reloaded context's worker, so a second claim in
    // the same instant must not hand the same job out twice.
    const doubleClaim = await page.evaluate(
      ([lib, owner]) => window.__selfhubContract!.jobs.claim(lib as string, owner as string),
      [libraryId, 'worker-second'] as const
    );
    expect(doubleClaim.job).toBeNull();
  });

  test('任务状态只写在 jobs_v3，不影响内容版本', async ({ page }) => {
    // The suite covers this in detail; this test states it as its own acceptance
    // item so a regression is attributed to the right requirement.
    const results = (await page.evaluate(() =>
      window.__selfhubContract!.jobs.run(`revision${Date.now()}`)
    )) as CheckResult[];

    const revisionCheck = results.find((r) => r.name.includes('内容版本'));
    expect(revisionCheck, '应包含内容版本检查项').toBeTruthy();
    expect(revisionCheck!.ok, revisionCheck!.detail).toBe(true);
  });

  test('设置页仍可正常打开（任务层未破坏现有界面）', async ({ page }) => {
    await page.goto('/#/settings/storage');
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText('数据与备份').first()).toBeVisible();
  });
});
