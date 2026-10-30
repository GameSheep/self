import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

/**
 * P2-07: performance fixture and measurements (§15.4).
 *
 * The dev doc sets targets and says to "记录设备/浏览器和构建版本后测量，不把本节目标当
 * 当前实测". So this spec builds a synthetic library, measures the things the targets
 * are about, and writes the numbers — with the environment — to
 * `docs/perf-baseline.json`. It asserts only the targets that are stated as product
 * requirements (bounded first render), and reports the rest.
 *
 * Fixture size: 2,000 notes + 4,000 annotations + 600 bookmarks + 200 reminders.
 * The doc's stress case (10k metadata / 2k notes / 100k annotations) is larger; the
 * annotation count here is deliberately smaller because every annotation is a full
 * JSON object in the legacy payload and 100k of them would make the *fixture* the
 * bottleneck rather than the app. The measured numbers are therefore a lower bound —
 * stated as such in the artifact.
 */

const FIXTURE = { notes: 2000, annotations: 4000, sites: 600, reminders: 200 };
const ARTIFACT = 'docs/perf-baseline.json';

function buildLargeState() {
  const now = Date.now();
  const notes = Array.from({ length: FIXTURE.notes }, (_, i) => ({
    id: `n${i}`,
    title: `笔记 ${i} 性能`,
    // ~1 KB bodies, so the payload is a realistic multi-megabyte one.
    content: `# 笔记 ${i}\n\n${'正文内容用于测量列表与搜索的开销。'.repeat(30)}`,
    tags: i % 3 === 0 ? ['性能'] : [],
    updatedAt: now - i * 1000
  }));
  const annotations = Array.from({ length: FIXTURE.annotations }, (_, i) => ({
    id: `a${i}`,
    pageTitle: `网页 ${i}`,
    pageUrl: `https://example.com/p/${i}`,
    text: `划线的原文 ${i} 性能`,
    note: i % 5 === 0 ? `我的批注 ${i}` : undefined,
    color: 'yellow',
    createdAt: now - i * 1000
  }));
  const sites = Array.from({ length: FIXTURE.sites }, (_, i) => ({
    id: `s${i}`,
    title: `站点 ${i}`,
    url: `https://site${i}.example.com`,
    category: i % 4 === 0 ? '工具' : '常用',
    createdAt: now - i * 1000
  }));
  const reminders = Array.from({ length: FIXTURE.reminders }, (_, i) => ({
    id: `r${i}`,
    title: `提醒 ${i}`,
    category: 'subscription',
    targetDate: now + i * 86_400_000,
    recurring: 'yearly',
    createdAt: now
  }));
  return {
    theme: 'dark',
    categories: ['常用', '工具'],
    sites,
    servers: [],
    secrets: [],
    checkIns: [],
    reminders,
    notes,
    handwritings: [],
    inbox: [],
    projects: [],
    annotations,
    obsidianNotes: [],
    obsidianConfig: {
      enabled: false,
      bucket: '',
      endpoint: '',
      region: '',
      accessKeyId: '',
      accessKeySecret: '',
      prefix: ''
    },
    wucaiConfig: { enabled: false, token: '' },
    youdaoConfig: { enabled: false, token: '' },
    aiConfig: { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' },
    cloudflareSync: { enabled: false, workerUrl: '', syncKey: '', autoSync: false },
    backupPolicy: { provider: 'auto', enabled: false, format: 'legacy' }
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 10) / 10;
}

test.describe('P2-07 性能基线', () => {
  test('大夹具下首页可用、列表首屏有界、搜索 P95 可测', async ({ page }, testInfo) => {
    const state = buildLargeState();
    const payloadKb = Math.round(JSON.stringify(state).length / 1024);

    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key as string, value as string);
        window.localStorage.setItem('selfhub_onboarded', '1');
      },
      ['self_hub_data_v2', JSON.stringify(state)] as const
    );

    const startedAt = Date.now();
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    const mainVisibleMs = Date.now() - startedAt;

    // The home page must be usable without touching every body: the quick-capture
    // box is the primary action of the first path.
    await expect(page.getByTestId('home-capture-input')).toBeVisible({ timeout: 10_000 });
    const homeInteractiveMs = Date.now() - startedAt;

    // Library: bounded first render (product requirement §15.4 ≤100 rows).
    // 全部资料 is gone; 网页批注 is the list pane now (4000 annotations in the fixture), so the
    // same component, filters and show-more are measured against it.
    const libraryStart = Date.now();
    await page.goto('/#/library?type=webpage');
    await expect(page.locator('[data-testid="annotations-list"]')).toBeVisible();
    const libraryVisibleMs = Date.now() - libraryStart;
    const initialRows = await page.locator('[data-annotation-id]').count();
    expect(initialRows, '首次渲染不应超过 100 条').toBeLessThanOrEqual(100);

    // "Show more" keeps the list honest about how much is left.
    await page.locator('[data-testid="annotations-show-more"]').click();
    const rowsAfterMore = await page.locator('[data-annotation-id]').count();
    expect(rowsAfterMore).toBeGreaterThan(initialRows);
    expect(rowsAfterMore).toBeLessThanOrEqual(200);

    // Local search over the filtered library: measure 12 queries.
    //
    // "Applied" is two animation frames after the input event: the filter runs through
    // `useDeferredValue`, so a single frame would sometimes measure the frame before
    // React committed the new list. This is a UI-level number (input → painted), which
    // is what the §15.4 target is about.
    const searchInput = page.locator('[data-testid="annotations-search"]');
    const matchCount = page.locator('[data-testid="annotations-count"]');
    const queries = ['网页 1', '性能', '网页 199', 'example', 'site', '提醒', '网页 5', '正文', '工具', '批注', '网页 42', '内容'];
    const searchMs: number[] = [];
    for (const query of queries) {
      const start = Date.now();
      await searchInput.fill(query);
      await expect(matchCount).toContainText('共');
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      );
      searchMs.push(Date.now() - start);
    }

    // The global palette (unified search) scans every collection per keystroke, so it
    // belongs in the same fixture: this is the box a user actually types into.
    // Blur the library input first: global shortcuts deliberately do not fire while a
    // text field has focus (§4.2), so Ctrl+K from inside an input is a no-op by design.
    await page.locator('[data-testid="annotations-count"]').click();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('global-search-input')).toBeVisible({ timeout: 5_000 });
    const paletteQueries = ['笔记 1', '性能', '正文'];
    const paletteMs: number[] = [];
    for (const query of paletteQueries) {
      const start = Date.now();
      await page.getByTestId('global-search-input').fill(query);
      await expect(page.locator('[data-search-group="note"]')).toBeVisible({ timeout: 10_000 });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      );
      paletteMs.push(Date.now() - start);
    }
    await page.keyboard.press('Escape');

    const report = {
      measuredAt: new Date().toISOString(),      environment: {
        userAgent: await page.evaluate(() => navigator.userAgent),
        viewport: testInfo.project.use.viewport ?? { width: 1440, height: 900 },
        nodePlatform: `${process.platform}`,
        browser: 'chromium (Playwright)'
      },
      fixture: {
        ...FIXTURE,
        payloadKb,
        note: '开发文档的压测夹具是 1 万条元数据 / 2 千篇笔记 / 10 万条批注；这里批注数为 4 千以避免夹具本身成为瓶颈，因此数值是下界。'
      },
      measurements: {
        mainVisibleMs,
        homeInteractiveMs,
        libraryVisibleMs,
        libraryInitialRows: initialRows,
        libraryRowsAfterShowMore: rowsAfterMore,
        searchMs: {
          p50: percentile(searchMs, 50),
          p95: percentile(searchMs, 95),
          max: Math.max(...searchMs)
        },
        paletteMs: {
          queries: paletteQueries.length,
          max: Math.max(...paletteMs),
          values: paletteMs
        }
      },
      docTargets: {
        homeInteractive: '≤ 2000ms',
        searchP95: '≤ 300ms',
        initialListRows: '≤ 100 条'
      }
    };

    // Report the numbers in the test log as well, so a failing CI run shows them.
    console.log('[perf]', JSON.stringify(report.measurements));

    mkdirSync('docs', { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    // Product requirements that must hold regardless of machine speed.
    expect(report.measurements.libraryInitialRows).toBeLessThanOrEqual(100);
    // Home must be interactive within the doc's 2s target on this machine class.
    expect(homeInteractiveMs, `首页可交互 ${homeInteractiveMs}ms`).toBeLessThanOrEqual(2000);
  });

  /**
   * The v3 write path on a large library.
   *
   * In v3 mode every save goes through `writeLibrary`, which is incremental per record but
   * still *reads* the library to compare against what is stored. That read is the cost this
   * measures — it is the number that decides whether "edits stay fast" survives the switch
   * to a real library, and nothing had measured it before.
   *
   * Three cases, because they cost different things:
   *   - first write: everything is new;
   *   - no-op write: pure read + compare (this is what a save that changed nothing pays);
   *   - one changed note: read + compare + one put.
   */
  test('v3 库的大库写入延迟：首次 / 无变化 / 改一条', async ({ page }) => {
    const state = buildLargeState();
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key as string, value as string);
        window.localStorage.setItem('selfhub_onboarded', '1');
      },
      ['self_hub_data_v2', JSON.stringify(state)] as const
    );
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    const timings = await page.evaluate(async () => {
      const contract = window.__selfhubContract!;
      const libraryId = 'perf-library';
      const measure = async (label: string) => {
        const started = performance.now();
        const result = await contract.library.save(libraryId);
        const elapsed = performance.now() - started;
        return { label, elapsed: Math.round(elapsed), ok: result.ok, counts: result.counts };
      };

      const first = await measure('first');
      const noop = await measure('noop');

      // Change exactly one note, then write again.
      const raw = window.localStorage.getItem('self_hub_data_v2');
      const payload = raw ? JSON.parse(raw) : {};
      const notes = Array.isArray(payload.notes) ? payload.notes : [];
      if (notes.length > 0) {
        notes[0] = { ...notes[0], title: `${notes[0].title}（改）` };
      }
      window.localStorage.setItem('self_hub_data_v2', JSON.stringify({ ...payload, notes }));
      const single = await measure('single');

      return { first, noop, single };
    });

    console.log('[perf:v3]', JSON.stringify(timings));

    expect(timings.first.ok).toBe(true);
    expect(timings.noop.ok).toBe(true);
    expect(timings.single.ok).toBe(true);
    // The library really holds the fixture (2,000 notes + 600 sites + …).
    expect(timings.noop.counts?.items_v3).toBeGreaterThanOrEqual(2600);

    // Persist the numbers next to the rest of the baseline, so "did this change cost a save
    // anything?" has an answer that outlives the test log.
    try {
      const baseline = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Record<string, unknown>;
      baseline.v3Write = {
        fixture: FIXTURE,
        records: timings.noop.counts?.items_v3,
        firstWriteMs: timings.first.elapsed,
        noChangeWriteMs: timings.noop.elapsed,
        oneChangedNoteMs: timings.single.elapsed,
        measuredAt: new Date().toISOString()
      };
      writeFileSync(ARTIFACT, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    } catch {
      // The other test in this file writes the artifact; if it is missing, the log above is
      // still the evidence and this is not worth failing the run over.
    }

    // A save that changed nothing is the per-save floor: it must stay in the range where a
    // typing burst (debounced at 800ms) cannot pile up. 1s is a regression guard, not a
    // product promise — it is far above the measured value on this machine.
    expect(timings.noop.elapsed, `无变化写入 ${timings.noop.elapsed}ms`).toBeLessThan(1000);
    expect(timings.single.elapsed, `改一条写入 ${timings.single.elapsed}ms`).toBeLessThan(1000);
  });
});
