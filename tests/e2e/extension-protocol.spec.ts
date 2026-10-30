import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * P2-04: the extension's single write entry point, verified in a **real
 * extension context**.
 *
 * The dev doc is explicit that a mocked page cannot stand in for this (§15.1:
 * "扩展生命周期需真实扩展上下文验证，普通网页 mock 不能替代"), so this spec loads
 * the unpacked extension into Chromium, talks to the live MV3 service worker and
 * checks what actually lands in the extension-origin database.
 *
 * Three claims:
 *  1. A page-driven capture really is written to the extension store (one writer).
 *  2. The command whitelist and sender rules reject what they should — a content
 *     script cannot read the whole library, and a page cannot use an unknown
 *     command.
 *  3. A repeated `operationId` does not create a second record.
 */

const EXT_PATH = path.join(process.cwd(), 'extension');

let context: BrowserContext | null = null;
let extensionId = '';

async function launchWithExtension(): Promise<BrowserContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfhub-ext-'));
  return chromium.launchPersistentContext(userDataDir, {
    // `channel: 'chromium'` opts into the new headless mode, which is the only
    // headless mode that loads extensions. The default headless build ignores
    // `--load-extension`, and the service worker never appears.
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
}

/**
 * Best-effort stop of the extension's MV3 worker through CDP.
 *
 * Returns whether a `running` worker version was actually found and stopped. Chromium
 * does not reliably report one for an idle MV3 worker, so callers must not treat `false`
 * as a failure — they record it instead.
 */
async function stopServiceWorker(ctx: BrowserContext, wake: () => Promise<void>): Promise<boolean> {
  const browser = ctx.browser();
  if (!browser) return false;
  try {
    const cdp = await browser.newBrowserCDPSession();
    const versions: Array<{ versionId: number; runningStatus: string }> = [];
    cdp.on('ServiceWorker.workerVersionUpdated', (event: { versions?: typeof versions }) => {
      if (event.versions) versions.push(...event.versions);
    });
    await cdp.send('ServiceWorker.enable');
    // Wake the worker: an idle MV3 worker reports `stopped`, and there would be nothing
    // to stop.
    await wake();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const running = versions.filter((version) => version.runningStatus === 'running');
    for (const version of running) {
      await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    }
    await cdp.detach();
    return running.length > 0;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  // Extensions need a persistent context; a plain `page` fixture cannot load one.
  expect(fs.existsSync(path.join(EXT_PATH, 'manifest.json')), '扩展目录必须存在').toBe(true);
  context = await launchWithExtension();

  // The MV3 service worker registers itself; its URL carries the extension id.
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  }
  const url = worker.url();
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(url);
  expect(match, `无法从 service worker URL 取到扩展 ID: ${url}`).toBeTruthy();
  extensionId = match![1];
});

test.afterAll(async () => {
  await context?.close();
  context = null;
});

test.describe('新标签页：独立页（不是工作台）', () => {
  test('新标签页是三栏独立页，右上角才进工作台', async () => {
    expect(extensionId).toBeTruthy();
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/newtab.html`);
    await expect(page.locator('body')).toBeVisible();

    // Still the new tab page: it must NOT have redirected into the workbench.
    expect(page.url()).toContain('/newtab.html');

    // The three columns are there…
    await expect(page.locator('[aria-label="笔记"]')).toBeVisible();
    await expect(page.locator('#search-input')).toBeVisible();
    await expect(page.locator('[aria-label="提醒"]')).toBeVisible();
    // 签到不再是右栏卡片：它是中间列的一条横排站点清单（无站点时隐藏）。
    await expect(page.locator('#checkins-strip')).toHaveCount(1);
    await expect(page.locator('#checkins-strip')).toBeHidden();
    // …and there is no workbench sidebar on this page.
    await expect(page.locator('aside [data-nav-child]')).toHaveCount(0);

    // The only way into the workbench is the top-right link.
    const workspace = page.locator('#open-workspace');
    await expect(workspace).toHaveText(/进入工作台/);
    await expect(workspace).toHaveAttribute('href', /app\/index\.html#\/home$/);
    await page.close();
  });

  test('常用网站由用户点 ☆ 决定，并记住选择', async () => {
    expect(extensionId).toBeTruthy();
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/newtab.html`);

    // Seed the same payload the workbench writes, from the same origin.
    await page.evaluate(() => {
      localStorage.setItem(
        'self_hub_data_v2',
        JSON.stringify({
          sites: [
            { id: 'site-a', title: 'GitHub', url: 'https://github.com', category: '开发', createdAt: 1 },
            { id: 'site-b', title: 'V2EX', url: 'https://v2ex.com', category: '社区', createdAt: 1 }
          ],
          notes: [{ id: 'note-1', title: '一条笔记', content: '正文', updatedAt: Date.now() }],
          reminders: [],
          checkIns: []
        })
      );
      localStorage.removeItem('selfhub_newtab_pins');
    });
    await page.reload();

    // Both sites are listed, but nothing is "常用" until the user says so.
    await expect(page.locator('#all-sites')).toContainText('GitHub');
    await expect(page.locator('#pinned-sites')).toContainText('还没有常用网站');
    await expect(page.locator('#notes-list')).toContainText('一条笔记');

    await page.locator('[data-pin="site-a"]').first().click();
    await expect(page.locator('#pinned-sites [data-site-id="site-a"]')).toBeVisible();

    // Persisted in extension storage, not just in memory.
    const stored = await page.evaluate(
      () => new Promise((resolve) => chrome.storage.local.get(['selfhub_newtab_pins'], (r) => resolve(r.selfhub_newtab_pins)))
    );
    expect(stored).toEqual(['site-a']);

    // Search reads the workbench payload across collections.
    await page.locator('#search-input').fill('GitHub');
    await expect(page.locator('#results')).toContainText('网站');

    // Unpin empties the 常用 区 again.
    await page.locator('#pinned-sites [data-pin="site-a"]').click();
    await expect(page.locator('#pinned-sites')).toContainText('还没有常用网站');
    await page.close();
  });
});

test.describe('新标签页：分类归并 + tab', () => {
  test('旧的长分类名被归并成固定分类，用 tab 切换', async () => {
    expect(extensionId).toBeTruthy();
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/newtab.html`);

    await page.evaluate(() => {
      localStorage.setItem(
        'self_hub_data_v2',
        JSON.stringify({
          sites: [
            { id: 'g1', title: 'GitHub', url: 'https://github.com', category: '技术开发' },
            { id: 'g2', title: 'ChatGPT', url: 'https://chat.openai.com', category: 'AI 聊天助手' },
            { id: 'g3', title: 'Claude', url: 'https://claude.ai', category: 'AI 聊天助手' },
            { id: 'g4', title: '阿里云', url: 'https://www.aliyun.com', category: '服务与后台' },
            { id: 'g5', title: '某导航', url: 'https://nav.example.com', category: '导航、个人项目与用途待确认' },
            { id: 'g6', title: 'V2EX', url: 'https://v2ex.com', category: '技术社区与编程学习' }
          ],
          notes: [],
          reminders: [],
          checkIns: []
        })
      );
      localStorage.removeItem('selfhub_newtab_pins');
    });
    await page.reload();

    const tabs = await page
      .locator('#all-sites .tab')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-bucket')));
    // 固定顺序 + 空分类不出现：「技术社区与编程学习」必须归到社区而不是开发。
    expect(tabs).toEqual(['全部', '开发', '运维', 'AI', '社区', '其他']);

    await page.locator('#all-sites .tab[data-bucket="AI"]').click();
    await expect(page.locator('#all-sites .chip')).toHaveCount(2);
    await expect(page.locator('#all-sites')).toContainText('Claude');
    await expect(page.locator('#all-sites')).not.toContainText('阿里云');
    await page.close();
  });
});

test.describe('新标签页：网页批注卡片', () => {
  test('批注按最近排序显示，点击进工作台条目页；没有批注时空态指路', async () => {
    expect(extensionId).toBeTruthy();
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/newtab.html`);

    // 空数据：卡片在，但给的是「怎么才有」的指路文案，而不是空白。
    await expect(page.locator('[aria-label="网页批注"]')).toBeVisible();
    await expect(page.locator('#annotations-list')).toContainText('划词保存');

    // Seed annotations the same way the workbench stores them.
    const now = Date.now();
    await page.evaluate((ts) => {
      localStorage.setItem(
        'self_hub_data_v2',
        JSON.stringify({
          sites: [],
          notes: [],
          reminders: [],
          checkIns: [],
          annotations: [
            {
              id: 'ann-old',
              pageUrl: 'https://example.com/a',
              pageTitle: '旧页面',
              text: '较早的划线',
              note: '',
              color: 'blue',
              createdAt: ts - 86400000,
              updatedAt: ts - 86400000
            },
            {
              id: 'ann-new',
              pageUrl: 'https://example.com/b',
              pageTitle: '新页面',
              text: '最新的划线内容',
              note: '我的思考',
              color: 'green',
              createdAt: ts,
              updatedAt: ts
            }
          ]
        })
      );
    }, now);
    await page.reload();

    const list = page.locator('#annotations-list');
    // 最新在前：第一行是新页面那条，带批注摘要。
    const firstRow = list.locator('[data-annotation-id="ann-new"]');
    await expect(firstRow).toBeVisible();
    await expect(firstRow).toContainText('新页面');
    await expect(firstRow).toContainText('最新的划线内容');
    await expect(firstRow).toContainText('我的思考');

    // 点击进工作台条目页（webpage:{id}），不是原网页。
    await firstRow.click();
    await expect(page).toHaveURL(new RegExp(`/app/index\\.html#/library/item/webpage:${'ann-new'}$`));
    await page.close();
  });
});

test.describe('P2-04 扩展单写入口（真实扩展上下文）', () => {
  test('新标签页的快速记录通过后台写入扩展库，而不是自己写存储', async () => {
    expect(extensionId).toBeTruthy();
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    await expect(page.locator('body')).toBeVisible();

    const text = `quicknote-${Date.now()}`;
    const noteBox = page.locator('#quick-note');
    await noteBox.fill(text);

    // The page only prints 已保存 after the background's promise resolved, so this
    // wait proves the write completed *and* that the store exists. Reading the
    // database before that would let this test create an empty schema first, and
    // the background's own open would then never run an upgrade.
    await expect(page.locator('#note-status')).toHaveText('已保存', { timeout: 10_000 });

    // Read the extension-origin database directly, from the same origin.
    const stored = await page.evaluate(async () => {
      const open = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('selfhub_extension', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const db = await open();
      const row = await new Promise<unknown>((resolve) => {
        const tx = db.transaction('quicknote_v3', 'readonly');
        const get = tx.objectStore('quicknote_v3').get('current');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => resolve(null);
      });
      db.close();
      return row as { text?: string; updatedAt?: number } | null;
    });

    expect(stored, '快速记录应写入扩展库').toBeTruthy();
    expect(stored!.text).toBe(text);
    await page.close();
  });

  test('命令白名单与发送方校验在真实扩展上下文里生效', async () => {
    // `import()` is forbidden inside a ServiceWorkerGlobalScope by the HTML spec,
    // so the pure protocol functions are loaded from an extension *page* instead:
    // same origin, same real extension context, same module instance the worker
    // uses.
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    const result = await page.evaluate(async () => {
      const protocol = await import('./protocol.js');
      const envelope = protocol.validateEnvelope({
        protocolVersion: 1,
        requestId: 'req-1',
        command: 'DELETE_EVERYTHING',
        payload: {}
      });
      return {
        unknownCommand: Object.keys(protocol.COMMANDS).includes('DELETE_EVERYTHING'),
        envelopeOk: envelope.ok,
        // A content-script sender carries a tab; an extension page does not.
        contentSender: protocol.classifySender({ tab: { id: 3, url: 'https://example.com/' } }),
        pageSender: protocol.classifySender({ url: 'chrome-extension://abc/app/index.html' }),
        // GET_ALL_ANNOTATIONS is page-only.
        libraryAllowedForContent: protocol.COMMANDS.GET_ALL_ANNOTATIONS.senders.includes('content'),
        libraryAllowedForPage: protocol.COMMANDS.GET_ALL_ANNOTATIONS.senders.includes('page'),
        // A content script claiming a different page is rejected.
        mismatch: protocol.checkPageBinding(
          'SAVE_ANNOTATION',
          { annotation: { pageUrl: 'https://attacker.example/', text: 'x' } },
          { tab: { id: 1, url: 'https://real.example/' } }
        ),
        // Oversized payloads are refused rather than stored.
        tooLarge: protocol.validateEnvelope({
          protocolVersion: 1,
          requestId: 'req-2',
          command: 'CAPTURE_ENTRY',
          payload: { text: 'x'.repeat(protocol.MAX_PAYLOAD_CHARS + 10) }
        })
      };
    });

    expect(result.unknownCommand).toBe(false);
    expect(result.envelopeOk).toBe(true);
    expect(result.contentSender).toBe('content');
    expect(result.pageSender).toBe('page');
    // The whole library is never reachable from a page script.
    expect(result.libraryAllowedForContent).toBe(false);
    expect(result.libraryAllowedForPage).toBe(true);
    expect(result.mismatch.ok).toBe(false);
    expect(result.mismatch.code).toBe('PAGE_MISMATCH');
    expect(result.tooLarge.ok).toBe(false);
    expect(result.tooLarge.code).toBe('PAYLOAD_TOO_LARGE');
    await page.close();
  });

  test('同一 operationId 重复提交只产生一条收件箱记录', async () => {
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    await expect(page.locator('body')).toBeVisible();

    const operationId = `idem-${Date.now()}`;
    const payload = { text: '幂等测试内容', operationId };

    const outcome = await page.evaluate(async (op) => {
      const send = (command: string, body: Record<string, unknown>) =>
        new Promise<{ ok: boolean; data?: unknown; error?: { code?: string } }>((resolve) => {
          chrome.runtime.sendMessage(
            {
              protocolVersion: 1,
              requestId: `req-${Math.random().toString(36).slice(2)}`,
              command,
              payload: body
            },
            (response) => resolve(response ?? { ok: false })
          );
        });

      const first = await send('CAPTURE_ENTRY', op);
      const second = await send('CAPTURE_ENTRY', op);

      const count = await new Promise<number>((resolve) => {
        const request = indexedDB.open('selfhub_extension', 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('inbox_v3', 'readonly');
          const all = tx.objectStore('inbox_v3').getAll();
          all.onsuccess = () => {
            const rows = (all.result || []) as Array<{ operationId?: string }>;
            resolve(rows.filter((row) => row.operationId === op.operationId).length);
            db.close();
          };
          all.onerror = () => {
            resolve(-1);
            db.close();
          };
        };
        request.onerror = () => resolve(-1);
      });

      return { first, second, count };
    }, payload);

    expect(outcome.first.ok, JSON.stringify(outcome.first.error)).toBe(true);
    expect(outcome.second.ok).toBe(true);
    expect(outcome.count, '同一 operationId 只应有一条记录').toBe(1);
    await page.close();
  });

  test('未知命令会被拒绝，并带上可诊断的错误码', async () => {
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    await expect(page.locator('body')).toBeVisible();

    const response = await page.evaluate(
      () =>
        new Promise<{ ok: boolean; error?: { code?: string } }>((resolve) => {
          chrome.runtime.sendMessage(
            {
              protocolVersion: 1,
              requestId: 'req-unknown',
              command: 'STEAL_ALL_CREDENTIALS',
              payload: {}
            },
            (res) => resolve(res ?? { ok: false })
          );
        })
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('UNKNOWN_COMMAND');
    await page.close();
  });

  test('settings 页不再提供服务商密钥表单，只指向统一设置', async () => {
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator('#open-settings')).toBeVisible();

    // The old duplicate key form must be gone.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator('#webdav-pass')).toHaveCount(0);
    await expect(page.locator('body')).toContainText('设置已移动到工作台');
    await page.close();
  });

  /**
   * The packaged workspace inside the extension (`extension/app/`).
   *
   * `npm run package:extension` copies the production build here, and this is the page a
   * user opens from the extension — but nothing tested that it actually boots. A build change
   * (extra chunks, tree-shaking metadata, lazy imports) can break it while `vite preview`
   * still looks perfect, because the two serve the bundle from different origins and with
   * different CSP.
   */
  test('扩展内嵌的工作台页面能启动并保存一条记录', async () => {
    const page = await context!.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`chrome-extension://${extensionId}/app/index.html#/home`);
    // The shell renders from the embedded bundle (not from any dev server).
    await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 20_000 });

    // A fresh extension profile shows the first-run wizard; dismiss it if present.
    const skip = page.getByRole('button', { name: /跳过|开始使用/ });
    if (await skip.count()) {
      await skip.first().click();
    }

    await page.getByTestId('home-capture-input').fill('扩展内嵌工作台记录');
    await page.getByTestId('home-capture-submit').click();
    await expect(page.getByTestId('home-capture-feedback')).toContainText('已保存到本机', { timeout: 10_000 });

    // 站点瓦片会向各站点自身请求 /favicon.ico；离线或测试用的保留域名
    // （nav.example.com 等）解析失败是**预期场景**——瓦片回退到彩色首字母块，
    // 页面功能不受影响。JS 错误（pageerror 与其他 console error）仍然零容忍。
    const jsErrors = errors.filter((e) => !/^Failed to load resource/.test(e));
    expect(jsErrors, `扩展内嵌页面出现 JS 错误：${jsErrors.join(' | ')}`).toEqual([]);
    await page.close();
  });

  /**
   * MV3 lifecycle, as far as this harness can honestly take it.
   *
   * The design's concern is that the worker is disposable: a *fresh* worker must find its
   * state in storage and enforce the same rules. Stopping the worker through CDP
   * (`ServiceWorker.stopWorker`) is attempted here, but Chromium does not always report a
   * `running` version for an idle MV3 worker, so the assertions below do not depend on it:
   * they close every page (nothing survives in a renderer) and replay the same
   * `operationId` from a brand-new one. True worker termination on a real profile remains
   * a manual acceptance item — recorded in the progress notes rather than implied here.
   */
  test('状态与幂等规则不依赖页面：关闭全部页面后重放同一 operationId 仍只有一条', async () => {
    const operationId = `lifecycle-${Date.now()}`;

    const send = async (page: import('@playwright/test').Page) =>
      page.evaluate(
        async (op) =>
          new Promise<{ ok: boolean; error?: { code?: string } }>((resolve) => {
            chrome.runtime.sendMessage(
              { protocolVersion: 1, requestId: `req-${Math.random().toString(36).slice(2)}`, command: 'CAPTURE_ENTRY', payload: op },
              (response) => resolve(response ?? { ok: false })
            );
          }),
        { text: '重启前写入', operationId }
      );

    // 1. Write before the restart.
    const beforePage = await context!.newPage();
    await beforePage.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    const first = await send(beforePage);
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    await beforePage.close();

    // 2. Best effort: stop the worker so the next message has to start a new one.
    const stopped = await stopServiceWorker(context!, async () => {
      const wakePage = await context!.newPage();
      try {
        await wakePage.goto(`chrome-extension://${extensionId}/quickcapture.html`);
        await wakePage.evaluate(
          (op) =>
            new Promise<void>((resolve) => {
              chrome.runtime.sendMessage(
                { protocolVersion: 1, requestId: 'req-wake', command: 'CAPTURE_ENTRY', payload: op },
                () => resolve()
              );
            }),
          { text: '唤醒 worker', operationId: `wake-${Date.now()}` }
        );
      } finally {
        await wakePage.close();
      }
    });
    // Recorded, not asserted: see the note above.
    console.log(`[lifecycle] ServiceWorker.stopWorker 可用：${stopped}`);

    // 3. A brand-new page replays the same operationId.
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    const replay = await send(page);
    expect(replay.ok, JSON.stringify(replay.error)).toBe(true);

    const count = await page.evaluate(
      (op) =>
        new Promise<number>((resolve) => {
          const request = indexedDB.open('selfhub_extension', 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('inbox_v3', 'readonly');
            const all = tx.objectStore('inbox_v3').getAll();
            all.onsuccess = () => {
              const rows = (all.result || []) as Array<{ operationId?: string }>;
              resolve(rows.filter((row) => row.operationId === op).length);
              db.close();
            };
            all.onerror = () => {
              resolve(-1);
              db.close();
            };
          };
          request.onerror = () => resolve(-1);
        }),
      operationId
    );
    expect(count, '同一 operationId 仍只应有一条记录（状态在存储里，不在页面里）').toBe(1);

    // The earlier quick note is still readable from storage too.
    const quickNote = await page.evaluate(
      () =>
        new Promise<string | null>((resolve) => {
          const request = indexedDB.open('selfhub_extension', 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('quicknote_v3', 'readonly');
            const get = tx.objectStore('quicknote_v3').get('current');
            get.onsuccess = () => {
              resolve((get.result as { text?: string } | undefined)?.text ?? null);
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
    expect(quickNote, '扩展库的内容在页面全部关闭后仍然存在').toBeTruthy();
    await page.close();
  });

  test('两个扩展页面同时提交同一 operationId，仍然只有一条记录', async () => {
    const operationId = `multi-page-${Date.now()}`;

    const sendFromNewPage = async () => {
      const page = await context!.newPage();
      await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
      const result = await page.evaluate(
        async (op) =>
          new Promise<{ ok: boolean; error?: { code?: string } }>((resolve) => {
            chrome.runtime.sendMessage(
              { protocolVersion: 1, requestId: `req-${Math.random().toString(36).slice(2)}`, command: 'CAPTURE_ENTRY', payload: op },
              (res) => resolve(res ?? { ok: false })
            );
          }),
        { text: '多页面并发写入', operationId }
      );
      await page.close();
      return result;
    };

    const [a, b] = await Promise.all([sendFromNewPage(), sendFromNewPage()]);
    expect(a.ok, JSON.stringify(a.error)).toBe(true);
    expect(b.ok, JSON.stringify(b.error)).toBe(true);

    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    const count = await page.evaluate(
      (op) =>
        new Promise<number>((resolve) => {
          const request = indexedDB.open('selfhub_extension', 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('inbox_v3', 'readonly');
            const all = tx.objectStore('inbox_v3').getAll();
            all.onsuccess = () => {
              const rows = (all.result || []) as Array<{ operationId?: string }>;
              resolve(rows.filter((row) => row.operationId === op).length);
              db.close();
            };
            all.onerror = () => {
              resolve(-1);
              db.close();
            };
          };
          request.onerror = () => resolve(-1);
        }),
      operationId
    );
    expect(count, '并发提交同一 operationId 只应有一条记录').toBe(1);
    await page.close();
  });

  /**
   * The other three idempotent writes, which share `withIdempotency`.
   *
   * They were refactored from three transactions to one; without this test the
   * annotation and inbox-status paths would have been changed with no coverage at all.
   */
  test('批注保存/删除与收件箱状态的幂等规则（store 层，扩展上下文内）', async () => {
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/quickcapture.html`);
    await expect(page.locator('body')).toBeVisible();

    const outcome = await page.evaluate(async (suffix) => {
      const store = (await import('./store.js')) as {
        ExtensionStore: {
          saveAnnotation: (a: Record<string, unknown>, op?: string) => Promise<any>;
          deleteAnnotation: (id: string, op?: string) => Promise<any>;
          captureEntry: (p: Record<string, unknown>, op?: string) => Promise<any>;
          updateInboxStatus: (id: string, status: string, op?: string) => Promise<any>;
          listAnnotations: () => Promise<any[]>;
          listInbox: () => Promise<any[]>;
        };
      };
      const annotation = {
        id: `ann-test-${suffix}`,
        pageUrl: 'https://example.com/article',
        pageTitle: '测试页面',
        text: '被划线的原文',
        note: '我的批注'
      };

      const saved = await store.ExtensionStore.saveAnnotation(annotation, `save-${suffix}`);
      const replayed = await store.ExtensionStore.saveAnnotation(annotation, `save-${suffix}`);
      const activeAfterReplay = (await store.ExtensionStore.listAnnotations()).length;
      const deleted = await store.ExtensionStore.deleteAnnotation(annotation.id, `del-${suffix}`);
      const activeAfterDelete = (await store.ExtensionStore.listAnnotations()).length;

      const captured = await store.ExtensionStore.captureEntry({ text: '待处理条目' }, `cap-${suffix}`);
      const updated = await store.ExtensionStore.updateInboxStatus(captured.id, 'processed', `upd-${suffix}`);
      const inbox = await store.ExtensionStore.listInbox();
      const capturedRow = inbox.find((row) => row.id === captured.id);

      return { saved, replayed, activeAfterReplay, deleted, activeAfterDelete, captured, updated, capturedRow };
    }, Date.now());

    expect(outcome.saved.count, '保存后批注计数').toBe(1);
    // A replay is reported as a replay and does not add a second row.
    expect(outcome.replayed.replayed).toBe(true);
    expect(outcome.activeAfterReplay, '重放同一 operationId 不应新增记录').toBe(1);
    // Soft delete leaves a tombstone but is gone from the active list.
    expect(outcome.deleted.count).toBe(0);
    expect(outcome.activeAfterDelete).toBe(0);
    // Inbox status update works and is visible in the list.
    expect(outcome.updated.updated).toBe(true);
    expect(outcome.capturedRow?.status).toBe('processed');

    await page.close();
  });

  /**
   * 划词 → 工作台的**免刷新**导入。
   *
   * Boot import 只跑一次：工作台标签页开着时在网页上划词保存，新批注必须经后台的
   * `SELFHUB_CHANGED` 广播 live 到达「网页批注」面板，而不是等用户刷新页面。
   * 这正是用户报告过的场景：toast 说"已保存"，面板却空着，因为应用从不监听广播。
   */
  test('工作台开着时保存批注，网页批注面板免刷新出现', async () => {
    test.setTimeout(60_000);
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/app/index.html#/library?type=webpage`);
    await expect(page.getByTestId('annotations-pane')).toBeVisible({ timeout: 20_000 });

    // Fresh profile shows the first-run wizard; dismiss it if present.
    const skip = page.getByRole('button', { name: /跳过|开始使用/ });
    if (await skip.count()) await skip.first().click();

    // Give the boot import a beat, then save a brand-new annotation through the
    // command API — exactly what a content script's 划词保存 does.
    await page.waitForTimeout(1000);
    const suffix = String(Date.now());
    const saved = await page.evaluate(async (suffix) => {
      return await new Promise<{ ok: boolean; error?: { code?: string; message?: string } }>((resolve) => {
        chrome.runtime.sendMessage(
          {
            protocolVersion: 1,
            requestId: `req-${suffix}`,
            command: 'SAVE_ANNOTATION',
            payload: {
              operationId: `live-${suffix}`,
              annotation: {
                id: `ann-live-${suffix}`,
                pageUrl: 'https://example.com/live-article',
                pageTitle: '免刷新测试页',
                text: '免刷新导入的划词原文',
                note: '',
                color: 'purple',
                createdAt: Date.now(),
                updatedAt: Date.now()
              }
            }
          },
          (response) => resolve(response ?? { ok: false })
        );
      });
    }, suffix);
    expect(saved.ok, JSON.stringify(saved.error)).toBe(true);

    // The open workbench must pick it up on its own (broadcast → live import),
    // no reload.
    await expect(page.locator('main')).toContainText('免刷新导入的划词原文', { timeout: 15_000 });

    await page.close();
  });

  /**
   * The pane's manual 「从扩展同步」 button, in the real extension context.
   *
   * This is the diagnostic path for when the automatic imports *appear* to have
   * done nothing: the result line must say the extension answered, how many
   * annotations it holds, and how many were new — never a silent no-op. (The
   * store is shared across this spec's tests, so the exact counts vary; the
   * contract is "connected and accounted for".)
   */
  test('网页批注面板的手动「从扩展同步」报告扩展侧状态', async () => {
    test.setTimeout(60_000);
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/app/index.html#/library?type=webpage`);
    await expect(page.getByTestId('annotations-pane')).toBeVisible({ timeout: 20_000 });

    const skip = page.getByRole('button', { name: /跳过|开始使用/ });
    if (await skip.count()) await skip.first().click();

    await page.getByTestId('annotations-sync-extension').click();
    const result = page.getByTestId('annotations-sync-result');
    await expect(result).toBeVisible({ timeout: 15_000 });
    const text = await result.textContent();
    expect(text).toBeTruthy();
    // Connected: either everything is already in, nothing was saved yet, or new
    // rows were just imported. Never "no response" — that would mean a broken
    // build reached this page.
    expect(text!).toMatch(/扩展已连通/);
    expect(text!).not.toMatch(/没有响应/);

    await page.close();
  });
});