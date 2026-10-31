import { test, expect } from '@playwright/test';

/**
 * The production bundle, driven for real.
 *
 * Every other spec runs against the Vite **dev server**, where nothing is tree-shaken and
 * every module is fetched separately — so a production-only problem is invisible to them.
 * This spec loads the built artifact through `vite preview` and checks the three things
 * that a build change can plausibly break:
 *
 * 1. the app boots at all (a dropped module shows up as a blank page or a console error);
 * 2. a lazy chunk still loads on demand (settings is dynamically imported);
 * 3. the **migration** chunk still loads on demand — it is the one that was moved out of the
 *    entry with `advancedChunks` and pinned with `"sideEffects"` metadata, i.e. exactly the
 *    kind of module a bundler can decide to drop.
 *
 * The build itself is produced by the `webServer` entry in playwright.config.ts.
 */

const PREVIEW_URL = process.env.E2E_PREVIEW_URL || 'http://127.0.0.1:4173';

test.describe('生产构建冒烟（vite preview）', () => {
  test('构建产物能启动、懒加载能工作、迁移链路仍可用', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Fresh profile without the first-run wizard: the wizard is an overlay and this spec is
    // about the built bundle, not about onboarding (same flag the other specs set).
    await page.addInitScript(() => {
      window.localStorage.setItem('selfhub_onboarded', '1');
    });

    await page.goto(`${PREVIEW_URL}/#/home`);
    // 1. Boots: the shell and the first path are there.
    await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('home-capture-input')).toBeVisible();

    // A real write through the built bundle.
    await page.getByTestId('home-capture-input').fill('生产构建冒烟');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机');

    // 2. A lazy chunk: the settings page is dynamically imported.
    await page.goto(`${PREVIEW_URL}/#/settings`);
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 20_000 });

    // 3. The migration chunk: run the real switch in the built bundle. A migration needs a
    //    snapshot password; with one supplied this exercises the whole lazy path (the
    //    runner, sources, mapping and lock are all in the chunk that moved out of the entry).
    await page.goto(`${PREVIEW_URL}/#/settings/storage`);
    await expect(page.getByTestId('storage-mode')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('storage-advanced-toggle').click();
    await page.getByTestId('storage-migration-password').fill('production-smoke-password');
    await page.getByTestId('storage-mode-switch-v3').click();

    // `.first()`: the settings page can render the pane more than once (page variant plus the
    // modal variant's markup), and a strict-mode violation inside the poll would be swallowed
    // by the `catch` and read as "still pending" forever.
    const switched = page.getByTestId('storage-mode-current').first();
    const failure = page.getByTestId('storage-migration-error').first();
    expect(await page.getByTestId('storage-mode').count()).toBeGreaterThan(0);

    // Either outcome is acceptable for this smoke test — what matters is that the lazy chunk
    // loaded and answered instead of the page dying:
    //   - success: the mode flips to v3 and a migration report appears;
    //   - refusal: an explicit, readable error appears next to the button.
    // The mode element is visible from the start, so poll for the *outcome* rather than
    // asserting on whichever element happens to be present first. (`expect.poll(...).not.toBe`
    // resolves to void — the value must be re-read, not captured.)
    await expect
      .poll(
        async () => {
          // `count()` first: reading `textContent()` on an element that is not there yet
          // *waits* for it, which would consume the whole poll timeout inside the first
          // iteration instead of letting the poll re-check.
          const mode = (await switched.textContent().catch(() => null))?.trim();
          if (mode === 'v3') return 'switched';
          const hasError = (await failure.count()) > 0;
          const errorText = hasError ? await failure.first().textContent() : null;
          if (errorText) return 'refused';
          return 'pending';
        },
        { timeout: 30_000, message: '迁移链路应当给出结果（切换成功或明确错误）' }
      )
      .not.toBe('pending');

    const finalMode = (await switched.textContent().catch(() => null))?.trim();
    const finalError = (await failure.count()) > 0 ? await failure.first().textContent() : null;
    expect(
      finalMode === 'v3' || Boolean(finalError),
      `迁移链路应给出结果，实际 mode=${finalMode} error=${finalError}`
    ).toBe(true);
    expect(errors, `生产构建出现页面错误：${errors.join(' | ')}`).toEqual([]);
  });
});
