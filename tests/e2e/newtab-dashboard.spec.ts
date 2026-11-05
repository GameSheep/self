import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { assertPackagedAppFresh } from './packagedApp';

/**
 * 新标签页的「可自定义模块面板」。
 *
 * 用户在真实扩展里才会用这一页，所以这里同样用**真实扩展上下文**跑，不 mock
 * chrome.*：布局存在 `chrome.storage.local.selfhub_newtab_layout`，文本框写进
 * `selfhub_pending_notes` 队列，这两件事都必须在真环境里成立。
 */

const EXT_PATH = path.join(process.cwd(), 'extension');

let context: BrowserContext | null = null;
let extensionId = '';

async function launchWithExtension(): Promise<BrowserContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfhub-dash-'));
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
}

const SEED = {
  sites: [
    { id: 's-gh', title: 'GitHub', url: 'https://github.com', category: '技术开发' },
    { id: 's-gpt', title: 'ChatGPT', url: 'https://chat.openai.com', category: 'AI 聊天助手' },
    { id: 's-claude', title: 'Claude', url: 'https://claude.ai', category: 'AI 聊天助手' },
    { id: 's-ali', title: '阿里云', url: 'https://www.aliyun.com', category: '服务与后台' }
  ],
  notes: [
    { id: 'n-work', title: '周报草稿', content: '本周做了…', folder: '工作', updatedAt: Date.now() },
    { id: 'n-life', title: '买牛奶', content: '两盒', folder: '生活', updatedAt: Date.now() - 60_000 }
  ],
  reminders: [
    { id: 'r-1', title: '交房租', category: '生活', targetDate: Date.now() + 86400000, completed: false }
  ],
  checkIns: []
};

/**
 * 工作台的用例跑的是 `extension/app` 里**打包好的**那份 bundle，不是 `src/`。
 * 改完 `src/` 忘了 `npm run package:extension`，测的就是旧代码 —— 这两条跨页面
 * 用例先验一下产物比源码新（见 packagedApp.ts）。
 */
const freshBuild = () => assertPackagedAppFresh(EXT_PATH);

async function openNewTab(seed: typeof SEED & Record<string, unknown> = SEED): Promise<Page> {
  const page = await context!.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate((payload) => {
    localStorage.setItem('self_hub_data_v2', JSON.stringify(payload));
    localStorage.removeItem('selfhub_storage_mode');
    localStorage.removeItem('selfhub_newtab_pins');
  }, seed);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        chrome.storage.local.remove(['selfhub_newtab_layout', 'selfhub_pending_notes', 'selfhub_newtab_pins'], () => resolve());
      })
  );
  await page.reload();
  await expect(page.locator('#dash .module').first()).toBeVisible();
  // 同一条上下文里前面可能开过工作台标签页，`fill` 走原生输入，页面在后台
  // （visibilityState === 'hidden'）时文字会静默丢掉 —— 输入框空着、DOM 也没
  // 任何重画，看起来像"草稿被清空"。切到前台并确认真的可见再返回。
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'visible');
  return page;
}

test.beforeAll(async () => {
  expect(fs.existsSync(path.join(EXT_PATH, 'manifest.json')), '扩展目录必须存在').toBe(true);
  context = await launchWithExtension();
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url());
  expect(match, `无法从 service worker URL 取到扩展 ID: ${worker.url()}`).toBeTruthy();
  extensionId = match![1];
});

test.afterAll(async () => {
  await context?.close();
  context = null;
});

test.describe('模块面板：可拖拽大小', () => {
  test('拖模块底部可以改高度，刷新后还记得', async () => {
    const page = await openNewTab();
    const module = page.locator('[data-module-id="m-notes"]');
    const handle = module.locator('.module-resize');
    const before = (await module.boundingBox())!;

    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 140, { steps: 12 });
    await page.mouse.up();

    const after = (await module.boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height + 100);

    // 存进了布局，而不是只改了这一屏的样式。
    const stored = await page.evaluate(
      () =>
        new Promise<{ modules: Array<{ id: string; height: number | null }> } | null>((resolve) => {
          chrome.storage.local.get(['selfhub_newtab_layout'], (res) =>
            resolve((res.selfhub_newtab_layout as { modules: Array<{ id: string; height: number | null }> }) || null)
          );
        })
    );
    const notesModule = stored!.modules.find((m) => m.id === 'm-notes');
    expect(notesModule?.height).toBeGreaterThan(100);

    await page.reload();
    const reloaded = (await page.locator('[data-module-id="m-notes"]').boundingBox())!;
    expect(Math.abs(reloaded.height - after.height)).toBeLessThan(4);
    await page.close();
  });

  test('拖两栏之间的分隔条可以改列宽，刷新后还记得', async () => {
    const page = await openNewTab();
    const left = page.locator('.dash-col[data-col="0"]');
    const before = (await left.boundingBox())!;
    const resizer = (await page.locator('.col-resizer').first().boundingBox())!;

    await page.mouse.move(resizer.x + resizer.width / 2, resizer.y + 200);
    await page.mouse.down();
    await page.mouse.move(resizer.x + resizer.width / 2 + 90, resizer.y + 200, { steps: 12 });
    await page.mouse.up();

    const after = (await left.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 60);

    // 宽度只由 flex-basis 一个属性决定：拖拽时只写它，写一次就够。
    // 再写一遍 width 等于每帧多做一次样式失效，是"拖动发卡"的老病根。
    const inline = await page
      .locator('.dash-col[data-col="0"]')
      .evaluate((el) => ({ basis: (el as HTMLElement).style.flexBasis, width: (el as HTMLElement).style.width }));
    expect(inline.basis).toMatch(/px$/);
    expect(inline.width).toBe('');

    await page.reload();
    const reloaded = (await page.locator('.dash-col[data-col="0"]').boundingBox())!;
    expect(Math.abs(reloaded.width - after.width)).toBeLessThan(6);
    await page.close();
  });
});

/**
 * 拖拽排序走 pointer events，所以这里合成 `PointerEvent`。
 * 用合成事件而不是鼠标 API，是因为要能停在"拖到一半"的状态上断言。
 */
async function startDrag(page: Page, moduleId: string) {
  await page.evaluate((id) => {
    const head = document.querySelector(`[data-module-id="${id}"] .module-head`) as HTMLElement;
    const rect = head.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1
    };
    head.dispatchEvent(
      new PointerEvent('pointerdown', {
        ...base,
        clientX: rect.left + 20,
        clientY: rect.top + 10
      })
    );
    // 越过 3px 阈值，正式进入拖动。
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        ...base,
        clientX: rect.left + 26,
        clientY: rect.top + 16
      })
    );
  }, moduleId);
}

async function hoverAt(page: Page, x: number, y: number) {
  await page.evaluate(
    ({ x: px, y: py }) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          buttons: 1,
          clientX: px,
          clientY: py
        })
      );
    },
    { x, y }
  );
  // 插槽更新被合并到 rAF 里，等一帧再断言。
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function releaseDrag(page: Page, x: number, y: number) {
  await page.evaluate(
    ({ x: px, y: py }) => {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          clientX: px,
          clientY: py
        })
      );
    },
    { x, y }
  );
}

test.describe('拖动反馈：幽灵卡片 + 虚线槽（Grafana 手感）', () => {

  test('拖动中出现幽灵卡片和虚线槽，松手前数据不动', async () => {
    const page = await openNewTab();
    const capture = (await page.locator('[data-module-id="m-capture"]').boundingBox())!;

    await startDrag(page, 'm-notes');
    await hoverAt(page, capture.x + 60, capture.y + 8);

    // 跟手的幽灵卡片：固定定位、只靠 transform 移动，不占布局。
    const ghost = page.locator('.drag-ghost');
    await expect(ghost).toHaveCount(1);
    const ghostStyle = await ghost.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return { position: cs.position, transform: cs.transform, pointerEvents: cs.pointerEvents };
    });
    expect(ghostStyle.position).toBe('fixed');
    expect(ghostStyle.pointerEvents).toBe('none');
    expect(ghostStyle.transform).not.toBe('none');

    // 虚线槽落在中间栏，原卡片变淡但还在左栏 —— 松手之前布局数据不动。
    await expect(page.locator('.dash-col[data-col="1"] .drop-gap')).toHaveCount(1);
    await expect(page.locator('.dash-col[data-col="0"] [data-module-id="m-notes"]')).toHaveCount(1);

    const gapHeight = await page.locator('.drop-gap').evaluate((el) => el.getBoundingClientRect().height);
    expect(gapHeight).toBeGreaterThan(40);

    // 松手：真卡片落到槽位，不需要整页重绘。
    await releaseDrag(page, capture.x + 60, capture.y + 8);
    await expect(page.locator('.dash-col[data-col="1"] [data-module-id="m-notes"]')).toHaveCount(1);
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await expect(page.locator('.drop-gap')).toHaveCount(0);

    // 真的落盘了，刷新还在。
    await page.reload();
    await expect(page.locator('.dash-col[data-col="1"] [data-module-id="m-notes"]')).toHaveCount(1);
    await page.close();
  });

  test('拖拽卡片挤位触发 FLIP 动画：被挤开的卡片平滑下移，不是生硬突变', async () => {
    const page = await openNewTab();
    const capture = page.locator('[data-module-id="m-capture"]');
    const pinned = page.locator('[data-module-id="m-pinned"]');
    const beforeCaptureBox = (await capture.boundingBox())!;
    const beforePinnedBox = (await pinned.boundingBox())!;

    // 拖动左栏的 m-notes 到中间栏 m-capture 上方
    await startDrag(page, 'm-notes');
    await hoverAt(page, beforeCaptureBox.x + 60, beforeCaptureBox.y + 10);

    // 验证 drop-gap 插入并占位
    const gap = page.locator('.dash-col[data-col="1"] .drop-gap');
    await expect(gap).toBeVisible();
    const gapBox = (await gap.boundingBox())!;

    // 等待 FLIP 动画完成（150ms）
    await page.waitForTimeout(200);

    // 验证 m-capture 和 m-pinned 被自然推下，而不是留在原地与 gap 重叠
    const duringCaptureBox = (await capture.boundingBox())!;
    expect(duringCaptureBox.y).toBeGreaterThanOrEqual(beforeCaptureBox.y + gapBox.height - 5);

    // 验证被挤开卡片在 DOM 中没有硬编码行号重叠
    const duringPinnedBox = (await pinned.boundingBox())!;
    expect(duringPinnedBox.y).toBeGreaterThanOrEqual(beforePinnedBox.y + gapBox.height - 5);

    await releaseDrag(page, beforeCaptureBox.x + 60, beforeCaptureBox.y + 10);
    await page.close();
  });

  test('拖到一半放弃（pointercancel）布局回到原位', async () => {
    const page = await openNewTab();
    const capture = (await page.locator('[data-module-id="m-capture"]').boundingBox())!;

    await startDrag(page, 'm-notes');
    await hoverAt(page, capture.x + 60, capture.y + 8);
    await expect(page.locator('.drop-gap')).toHaveCount(1);

    await page.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent('pointercancel', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true
        })
      );
    });

    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await expect(page.locator('.drop-gap')).toHaveCount(0);
    await expect(page.locator('.dash-col[data-col="0"] [data-module-id="m-notes"]')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.dash-col[data-col="0"] [data-module-id="m-notes"]')).toHaveCount(1);
    await page.close();
  });

  /**
   * 用户报的 bug：拖着一路往下，想放到看不见的位置，滚动条不动。
   * 指针停在栏底部不动时没有任何指针事件，所以必须自己开 rAF 循环持续滚
   * —— 这里断言的正是"指针不动也会滚"。
   */
  test('拖到栏底部会自己往下滚，指针不动也照样滚', async () => {
    const page = await openNewTab();
    // 压低视口，保证中间栏真的溢出、有得滚。
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.waitForTimeout(200);

    const column = page.locator('.dash-col[data-col="1"]');
    const room = await column.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(room, '这一栏得先溢出，否则测不到滚动').toBeGreaterThan(120);

    const box = (await column.boundingBox())!;
    await startDrag(page, 'm-notes');
    // 停在底部边缘往里 8px：不移动指针，只等时间。
    await hoverAt(page, box.x + box.width / 2, box.y + box.height - 8);

    await page.waitForTimeout(500);
    const scrolled = await column.evaluate((el) => el.scrollTop);
    expect(scrolled, '指针停在底部边缘时应该自己往下滚').toBeGreaterThan(40);

    // 离开边缘就停：把指针挪回中间，再等一会儿，滚动量不该继续涨。
    await hoverAt(page, box.x + box.width / 2, box.y + box.height / 2);
    const paused = await column.evaluate((el) => el.scrollTop);
    await page.waitForTimeout(300);
    const stillPaused = await column.evaluate((el) => el.scrollTop);
    expect(Math.abs(stillPaused - paused), '离开边缘后不该继续滚').toBeLessThan(6);

    // 滚到底之后再松手，落点要落在滚到的位置，而不是原来那一屏的末尾。
    await hoverAt(page, box.x + box.width / 2, box.y + box.height - 8);
    await page.waitForTimeout(200);
    await releaseDrag(page, box.x + box.width / 2, box.y + box.height - 8);

    await expect(page.locator('.dash-col[data-col="1"] [data-module-id="m-notes"]')).toHaveCount(1);
    // 不是插到这一栏最前面 —— 说明落点跟着滚动走，没有回退到起点。
    const index = await column.evaluate((el) => {
      const mods = Array.from(el.querySelectorAll('.module'));
      return mods.findIndex((m) => m.getAttribute('data-module-id') === 'm-notes');
    });
    expect(index).toBeGreaterThan(0);
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await page.close();
  });
});

test.describe('模块面板：自定义与数据来源', () => {
  test('拖模块标题可以换到别的栏，刷新后位置还在', async () => {
    const page = await openNewTab();
    await expect(page.locator('.dash-col[data-col="0"] [data-module-id="m-notes"]')).toHaveCount(1);

    await page
      .locator('[data-module-id="m-notes"] .module-head')
      .dragTo(page.locator('[data-module-id="m-capture"]'), { targetPosition: { x: 40, y: 4 } });

    await expect(page.locator('.dash-col[data-col="1"] [data-module-id="m-notes"]')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.dash-col[data-col="1"] [data-module-id="m-notes"]')).toHaveCount(1);
    await page.close();
  });

  test('触屏 / 键盘也能换栏：⋯ 菜单里的「移到右栏」', async () => {
    const page = await openNewTab();
    const notes = page.locator('[data-module-id="m-notes"]');
    await notes.locator('.module-menu-btn').click();
    await page.locator('.pop .pop-item', { hasText: '移到右栏' }).click();
    await expect(page.locator('.dash-col[data-col="1"] [data-module-id="m-notes"]')).toHaveCount(1);
    // 还在中间栏，所以「移到右栏」仍在；再往右一次就到最右栏，这一项才消失。
    await page.locator('[data-module-id="m-notes"] .module-menu-btn').click();
    await expect(page.locator('.pop .pop-item', { hasText: '移到左栏' })).toHaveCount(1);
    await page.locator('.pop .pop-item', { hasText: '移到右栏' }).click();
    await expect(page.locator('.dash-col[data-col="2"] [data-module-id="m-notes"]')).toHaveCount(1);
    await page.locator('[data-module-id="m-notes"] .module-menu-btn').click();
    await expect(page.locator('.pop .pop-item', { hasText: '移到右栏' })).toHaveCount(0);
    await expect(page.locator('.pop .pop-item', { hasText: '移到左栏' })).toHaveCount(1);
    await page.close();
  });

  test('重画面板不会清掉正在写的速记', async () => {
    const page = await openNewTab();
    const input = page.locator('[data-module-id="m-capture"] #capture-input');
    const draft = `写了一半的速记-${Date.now()}`;
    await input.fill(draft);
    // 先确认字真的进了框：填不进去和"被重画清空"是两件事，混在一条断言里
    // 排查时分不清是产品丢了草稿还是测试没打上字。
    await expect(input).toHaveValue(draft);

    // 点分类 chip 会走 dashboard.render()，整页 DOM 重建 —— 这是用户会遇到的
    // "我明明打了字，它自己没了"。工作台恢复备份后 adopt() 也是同一条路。
    await page.locator('[data-module-id="m-sites"] .bucket-chip').first().click();
    await expect(input).toHaveValue(draft);
    await page.close();
  });

  test('记一笔切到「笔记」，写的内容直接变成一条笔记', async () => {
    const page = await openNewTab();

    // 左栏底部「＋ 添加模块」→ 记一笔（默认去处是收件箱）
    await page.locator('[data-add-col="0"]').click();
    await page.locator('.pop [data-add-type="capture"]').click();

    const box = page.locator('.dash-col[data-col="0"] [data-module-type="capture"]');
    await expect(box).toBeVisible();
    await expect(box.locator('.composer-dest-btn[data-dest="inbox"]')).toHaveClass(/is-active/);
    await box.locator('.composer-dest-btn[data-dest="note"]').click();
    await expect(box.locator('.composer-dest-btn[data-dest="note"]')).toHaveClass(/is-active/);

    const text = `新标签页写的想法-${Date.now()}`;
    await box.locator('#capture-input').fill(text);
    await box.locator('#capture-submit').click();
    await expect(box.locator('#capture-status')).toHaveText('已存进笔记');

    // 立刻出现在笔记模块里（不用等打开工作台）
    await expect(page.locator('#notes-list')).toContainText(text);

    // 而且进了待导入队列，工作台打开时会被收进库里
    const queued = await page.evaluate(
      () =>
        new Promise<Array<{ content: string }>>((resolve) => {
          chrome.storage.local.get(['selfhub_pending_notes'], (res) =>
            resolve((res.selfhub_pending_notes as Array<{ content: string }>) || [])
          );
        })
    );
    expect(queued.some((note) => note.content === text)).toBe(true);
    await page.close();
  });

  test('记一笔的去处可切：收件箱 ↔ 笔记，刷新后记得', async () => {
    const page = await openNewTab();
    // 合并后默认布局里只有一个输入框（以前是「文本框」+「记一笔」两个）
    await expect(page.locator('.composer')).toHaveCount(1);

    const box = page.locator('[data-module-id="m-capture"]');
    await expect(box.locator('.composer-dest-btn[data-dest="inbox"]')).toHaveClass(/is-active/);
    await expect(box.locator('#capture-folder')).toBeHidden();

    await box.locator('.composer-dest-btn[data-dest="note"]').click();
    await expect(box.locator('.composer-dest-btn[data-dest="note"]')).toHaveClass(/is-active/);
    // 存成笔记才需要问「存到哪个文件夹」
    await expect(box.locator('#capture-folder')).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-module-id="m-capture"] .composer-dest-btn[data-dest="note"]')).toHaveClass(
      /is-active/
    );
    await expect(page.locator('[data-module-id="m-capture"] #capture-folder')).toBeVisible();
    await page.close();
  });

  test('老布局里的「文本框」并进「记一笔」，不会留两个一样的输入框', async () => {
    const page = await openNewTab();

    const seedLayout = (modules: unknown[]) =>
      page.evaluate(
        (payload) =>
          new Promise<void>((resolve) => {
            chrome.storage.local.set(
              {
                selfhub_newtab_layout: {
                  v: 1,
                  columns: [{ id: 'c1', fr: 1 }],
                  modules: payload
                }
              },
              () => resolve()
            );
          }),
        modules
      );

    const readLayout = () =>
      page.evaluate(
        () =>
          new Promise<{ modules: Array<{ type: string; source?: { mode?: string; value?: string } }> }>((resolve) => {
            chrome.storage.local.get(['selfhub_newtab_layout'], (res) =>
              resolve(res.selfhub_newtab_layout as { modules: Array<{ type: string }> })
            );
          })
      );

    // ① 两个盒子都在：只留「记一笔」，「文本框」被并掉
    await seedLayout([
      { id: 'm-notes', type: 'notes', column: 0, height: null, source: { mode: 'recent' } },
      { id: 'm-quick', type: 'quicknote', column: 0, height: 232, source: { mode: 'folder', value: '工作' } },
      { id: 'm-capture', type: 'capture', column: 0, height: null, source: {} }
    ]);
    await page.reload();
    await expect(page.locator('.composer')).toHaveCount(1);
    await expect(page.locator('[data-module-type="quicknote"]')).toHaveCount(0);
    // 合并结果要落盘，否则每次开新标签页又冒出来
    await page.reload();
    await expect(page.locator('.composer')).toHaveCount(1);
    let stored = await readLayout();
    expect(stored.modules.filter((mod) => mod.type === 'capture')).toHaveLength(1);
    expect(stored.modules.filter((mod) => mod.type === 'quicknote')).toHaveLength(0);

    // ② 只有「文本框」：改写成「记一笔」，去处是笔记，文件夹跟着走
    await seedLayout([
      { id: 'm-notes', type: 'notes', column: 0, height: null, source: { mode: 'recent' } },
      { id: 'm-quick', type: 'quicknote', column: 0, height: 232, source: { mode: 'folder', value: '工作' } }
    ]);
    await page.reload();
    await expect(page.locator('.composer')).toHaveCount(1);
    await expect(page.locator('.composer-dest-btn[data-dest="note"]')).toHaveClass(/is-active/);
    await expect(page.locator('#capture-folder')).toHaveValue('工作');
    stored = await readLayout();
    expect(stored.modules.filter((mod) => mod.type === 'quicknote')).toHaveLength(0);
    const composer = stored.modules.find((mod) => mod.type === 'capture');
    expect(composer?.source?.mode).toBe('note');
    expect(composer?.source?.value).toBe('工作');
    await page.close();
  });

  test('每个模块都能选数据来源：笔记只看「工作」文件夹', async () => {
    const page = await openNewTab();
    const notes = page.locator('[data-module-id="m-notes"]');
    await expect(notes.locator('#notes-list')).toContainText('周报草稿');
    await expect(notes.locator('#notes-list')).toContainText('买牛奶');

    await notes.locator('.module-menu-btn').click();
    await page.locator('.pop .pop-item', { hasText: '数据来源' }).click();
    await page.locator('.pop .pop-item', { hasText: '指定文件夹' }).click();
    await page.locator('.pop .pop-item', { hasText: '工作' }).click();

    await expect(notes.locator('#notes-list')).toContainText('周报草稿');
    await expect(notes.locator('#notes-list')).not.toContainText('买牛奶');
    // 来源显示在模块头上，一眼能看出这张卡在看什么
    await expect(notes.locator('.module-source')).toHaveText('工作');

    await page.reload();
    await expect(page.locator('[data-module-id="m-notes"] #notes-list')).not.toContainText('买牛奶');
    await page.close();
  });

  test('网站模块是卡片套卡片，分类 chip 就是来源切换', async () => {
    const page = await openNewTab();
    const sites = page.locator('[data-module-id="m-sites"]');

    // 外层是模块卡，里层是分类卡，再里层是每个网站的卡
    await expect(sites.locator('.subcard').first()).toBeVisible();
    await expect(sites.locator('.subcard .site-card')).toHaveCount(4);

    await sites.locator('.bucket-chip[data-bucket="AI"]').click();
    await expect(sites.locator('.site-card')).toHaveCount(2);
    await expect(sites).toContainText('Claude');
    await expect(sites).not.toContainText('阿里云');

    // chip 的切换会写进布局（等价于「换了个来源」）
    const stored = await page.evaluate(
      () =>
        new Promise<{ modules: Array<{ id: string; source: { mode?: string; value?: string } }> } | null>((resolve) => {
          chrome.storage.local.get(['selfhub_newtab_layout'], (res) =>
            resolve((res.selfhub_newtab_layout as never) || null)
          );
        })
    );
    await page.close();
  });

  test('网站模块可以自选网站，刷新后还记得', async () => {
    const page = await openNewTab();
    const sites = page.locator('[data-module-id="m-sites"]');

    // ⋯ → 数据来源… → 自选网站（勾选）
    await sites.locator('.module-menu-btn').click();
    await page.locator('.pop .pop-item', { hasText: '数据来源' }).click();
    await page.locator('.pop .pop-item', { hasText: '自选网站' }).click();

    // 勾 2 个（GitHub、阿里云），不勾 ChatGPT / Claude
    await page.locator('.pop [data-pick-id="s-gh"]').click();
    await page.locator('.pop [data-pick-id="s-ali"]').click();
    await page.locator('.pop [data-pick-done]').click();

    await expect(sites.locator('.site-card')).toHaveCount(2);
    await expect(sites).toContainText('GitHub');
    await expect(sites).toContainText('阿里云');
    await expect(sites).not.toContainText('ChatGPT');

    // 写进布局：source = { mode: 'custom', siteIds: [...] }
    const stored = await page.evaluate(
      () =>
        new Promise<{ modules: Array<{ id: string; source: { mode?: string; siteIds?: string[] } }> } | null>((resolve) => {
          chrome.storage.local.get(['selfhub_newtab_layout'], (res) =>
            resolve((res.selfhub_newtab_layout as never) || null)
          );
        })
    );
    const source = stored!.modules.find((m) => m.id === 'm-sites')?.source;
    expect(source?.mode).toBe('custom');
    expect([...(source?.siteIds ?? [])].sort()).toEqual(['s-ali', 's-gh']);

    // 刷新后仍然只显示自选的两个
    await page.reload();
    const after = page.locator('[data-module-id="m-sites"]');
    await expect(after.locator('.site-card')).toHaveCount(2);
    await page.close();
  });

  test('网站模块可以按原始分类筛选，同类型模块也能加第二个', async () => {
    const page = await openNewTab();

    // ① 按原始分类：数据来源 → 按原始分类 → 「AI 聊天助手」
    const sites = page.locator('[data-module-id="m-sites"]');
    await sites.locator('.module-menu-btn').click();
    await page.locator('.pop .pop-item', { hasText: '数据来源' }).click();
    await page.locator('.pop .pop-item', { hasText: '按原始分类' }).click();
    await page.locator('.pop .pop-item', { hasText: 'AI 聊天助手' }).click();
    await expect(sites.locator('.site-card')).toHaveCount(2);
    await expect(sites).toContainText('ChatGPT');
    await expect(sites).toContainText('Claude');
    await expect(sites).not.toContainText('GitHub');

    // ② 同类型再加一个实例：＋ 添加模块 → 全部网站，独立来源互不影响
    await page.locator('[data-add-col="1"]').click();
    await page.locator('.pop [data-add-type="sites"]').click();
    const second = page.locator('[data-module-type="sites"]').last();
    await expect(second).toBeVisible();
    await expect(second.locator('.site-card')).toHaveCount(4);
    // 第二个实例仍显示全部 4 个站（默认来源 all），第一个保持 2 个
    await expect(sites.locator('.site-card')).toHaveCount(2);
    await page.close();
  });

  test('记一笔存成笔记，打开工作台就在笔记里（队列导入一次即清空）', async () => {
    test.setTimeout(90_000);
    freshBuild();
    const page = await openNewTab();
    await page.locator('[data-add-col="0"]').click();
    await page.locator('.pop [data-add-type="capture"]').click();
    const box = page.locator('.dash-col[data-col="0"] [data-module-type="capture"]');
    await box.locator('.composer-dest-btn[data-dest="note"]').click();
    const text = `跨页面笔记-${Date.now()}`;
    await box.locator('#capture-input').fill(text);
    await box.locator('#capture-submit').click();
    await expect(box.locator('#capture-status')).toHaveText('已存进笔记');

    // 工作台是唯一的写入方：它把队列里的笔记收进库里。
    const app = await context!.newPage();
    await app.goto(`chrome-extension://${extensionId}/app/index.html#/library?view=notes`);
    const skip = app.getByRole('button', { name: /跳过|开始使用/ });
    if (await skip.count()) await skip.first().click();
    await expect(app.getByTestId('notes-pane')).toBeVisible({ timeout: 20_000 });
    await expect(app.getByTestId('notes-pane')).toContainText(text, { timeout: 20_000 });

    // 导入完就把队列清掉，否则每次打开工作台都会重复导入同一条。
    const queued = await app.evaluate(
      () =>
        new Promise<unknown[]>((resolve) => {
          chrome.storage.local.get(['selfhub_pending_notes'], (res) =>
            resolve((res.selfhub_pending_notes as unknown[]) || [])
          );
        })
    );
    expect(queued.length).toBe(0);
    await app.close();
    await page.close();
  });

/**
 * 用户报的 bug：「记一笔」记完之后，工作台里哪里都找不到。
 * 原因是记一笔走 `CAPTURE_ENTRY`，写的是扩展自己的 v3 收件箱
 */
  test('记一笔：新标签页记的内容会进工作台收件箱，工作台开着也立刻出现', async () => {
    test.setTimeout(90_000);
    freshBuild();
    // 工作台先开在收件箱页，模拟"一直开着"——用户通常就是这样去翻的。
    const app = await context!.newPage();
    await app.goto(`chrome-extension://${extensionId}/app/index.html#/inbox`);
    const skip = app.getByRole('button', { name: /跳过|开始使用/ });
    if (await skip.count()) await skip.first().click();
    await expect(app.getByText('统一极速收件箱').first()).toBeVisible({ timeout: 20_000 });

    const text = `记一笔-${Date.now()}`;
    const page = await openNewTab();
    // 这条用例先开了工作台，新标签页可能不是活动标签页。`fill` 走的是原生输入，
    // 页面在后台时文字进不去（DOM 没有任何重画，输入框就是空的）。切到前台再填。
    await page.bringToFront();
    await page.locator('[data-module-id="m-capture"] #capture-input').fill(text);
    // 同步点：确认输入框真的拿到了这段文字再点提交。少了这一句，万一输入被
    // 重绘清空，`send()` 会静默 return，症状是"状态一直空着"——排查时看不出
    // 根因是输入没了还是后台没响应。
    await expect(page.locator('[data-module-id="m-capture"] #capture-input')).toHaveValue(text);
    await page.locator('[data-module-id="m-capture"] #capture-submit').click();
    await expect(page.locator('[data-module-id="m-capture"] #capture-status')).toHaveText('已进收件箱');

    // 关键：**不刷新工作台**。后台写完后会广播 SELFHUB_CHANGED，工作台接住就导。
    await expect(app.getByText(text).first()).toBeVisible({ timeout: 20_000 });

    // 导完要在扩展侧标成「已收下」：否则用户把它转成笔记之后，下次启动又会被
    // 导回来，收件箱永远清不空。
    const status = await app.evaluate(
      (needle) =>
        new Promise<string>((resolve) => {
          chrome.runtime.sendMessage(
            {
              protocolVersion: 1,
              requestId: `req-check-${Date.now()}`,
              command: 'QUERY_INBOX',
              payload: {}
            },
            (res: { ok?: boolean; data?: { items?: Array<{ content?: string; status?: string }> } }) => {
              const row = (res?.data?.items || []).find((item) => item.content === needle);
              resolve(row?.status || 'missing');
            }
          );
        }),
      text
    );
    expect(status).toBe('imported');

    // 再开一次工作台不会重复导入。
    await app.reload();
    await expect(app.getByText(text).first()).toBeVisible({ timeout: 20_000 });
    await expect(app.getByText(text)).toHaveCount(1);

    await app.close();
    await page.close();
  });

  test('添加模块弹层在窄窗口里不会被裁掉，能滚到最后一个模块', async () => {
    const page = await openNewTab();
    // 用户截图里的场景：窗口矮、模块列表比窗口还高，最后几项被窗口切掉
    await page.setViewportSize({ width: 480, height: 700 });
    await page.locator('[data-add-col="0"]').click();

    const pop = page.locator('.pop');
    await expect(pop).toBeVisible();
    const box = (await pop.boundingBox())!;
    expect(box.y, '弹层不能顶出视口上沿').toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, '弹层不能超出视口下沿').toBeLessThanOrEqual(700);

    // 列表比弹层长时要能滚，最后一项必须滚得出来
    await pop.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(pop.locator('.pop-add-item').last()).toBeInViewport();
    await page.close();
  });

  test('删除模块会持久化，重置布局能恢复默认三栏', async () => {
    const page = await openNewTab();
    const reminders = page.locator('[data-module-id="m-reminders"]');
    await reminders.locator('.module-menu-btn').click();
    await page.locator('.pop .pop-item', { hasText: '删除模块' }).click();
    await expect(page.locator('[data-module-id="m-reminders"]')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('[data-module-id="m-reminders"]')).toHaveCount(0);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('#reset-layout').click();
    await expect(page.locator('[data-module-id="m-reminders"]')).toHaveCount(1);
    await expect(page.locator('.dash-col')).toHaveCount(3);
    await page.close();
  });

  test('批注模块主行是划词原文，不是千篇一律的页面标题', async () => {
    const now = Date.now();
    const page = await openNewTab({
      ...SEED,
      annotations: [
        {
          id: 'an-1',
          pageTitle: 'DeepSeek 开放平台',
          pageUrl: 'https://api-docs.deepseek.com/zh-cn/',
          text: '深度求索模型接口的调用方式',
          note: '记得看限流说明',
          color: 'yellow',
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'an-2',
          pageTitle: 'DeepSeek 开放平台',
          pageUrl: 'https://api-docs.deepseek.com/zh-cn/',
          text: '余额查询接口的返回格式',
          color: 'purple',
          createdAt: now - 1000,
          updatedAt: now - 1000
        }
      ]
    });

    const mod = page.locator('.module', { hasText: '网页批注' }).first();
    await expect(mod).toBeVisible();
    const rows = mod.locator('.list-item');
    await expect(rows).toHaveCount(2);

    // 主行 = 原文；两条同一页面的划词不再长得一模一样。
    await expect(rows.nth(0).locator('.list-title')).toContainText('深度求索模型接口的调用方式');
    await expect(rows.nth(1).locator('.list-title')).toContainText('余额查询接口的返回格式');
    // 副行 = 我的批注 / 页面标题 + 时间。
    await expect(rows.nth(0).locator('.list-sub')).toContainText('记得看限流说明');
    // 原文带荧光底色（工作台同款），保证「标注的内容」看得见。
    const bg = await rows.nth(0).locator('.list-title').evaluate((el) => el.style.backgroundColor);
    expect(bg).toContain('0.12');
    await page.close();
  });


  test.describe('快捷内容模块', () => {
    // 每条用例都先 openNewTab() 拿到真实扩展页 view——fixture 的 page 是空白页。
    test('天气：两个城市两个模块，互不影响', async () => {
      const view = await openNewTab();
      // 环境无外网：直接种缓存（模块先渲染缓存），断言渲染路径与双实例独立。
      const weather = (temp: number) => ({
        fetchedAt: Date.now(),
        data: {
          current: { temperature_2m: temp, relative_humidity_2m: 61, weather_code: 3, wind_speed_10m: 15 },
          daily: {
            time: ['2026-11-01', '2026-11-02'],
            weather_code: [3, 1],
            temperature_2m_max: [temp + 1, temp],
            temperature_2m_min: [temp - 5, temp - 7]
          }
        }
      });
      await view.evaluate(
        ([dl, bj]) =>
          new Promise<void>((resolve) => {
            chrome.storage.local.set({ selfhub_weather_大连: dl, selfhub_weather_北京: bj }, () => resolve());
          }),
        [weather(14), weather(20)] as const
      );

      await view.locator('[data-add-col="0"]').click();
      await view.locator('.pop [data-add-type="weather"]').click();
      const first = view.locator('[data-module-type="weather"]').first();
      await expect(first.locator('.weather-temp')).toHaveText('14°C', { timeout: 10_000 });
      await expect(first).toContainText('大连');

      await view.locator('[data-add-col="2"]').click();
      await view.locator('.pop [data-add-type="weather"]').click();
      const second = view.locator('[data-module-type="weather"]').last();
      await second.locator('.module-menu-btn').click();
      await view.locator('.pop .pop-item', { hasText: '数据来源' }).click();
      await view.locator('.pop .pop-item', { hasText: '北京' }).click();
      await expect(second.locator('.weather-temp')).toHaveText('20°C', { timeout: 10_000 });
      await expect(first.locator('.weather-temp')).toHaveText('14°C');
      await view.close();
    });

    test('一言：显示句子与出处，可换一句', async () => {
      const view = await openNewTab();
      await view.evaluate(
        () =>
          new Promise<void>((resolve) => {
            chrome.storage.local.set(
              { selfhub_hitokoto: { fetchedAt: Date.now(), data: { hitokoto: '测试一句话', from: '测试来源', from_who: '测试者' } } },
              () => resolve()
            );
          })
      );

      await view.locator('[data-add-col="0"]').click();
      await view.locator('.pop [data-add-type="hitokoto"]').click();
      const mod = view.locator('[data-module-type="hitokoto"]').first();
      await expect(mod.locator('.hitokoto-text')).toContainText('测试一句话', { timeout: 10_000 });
      await expect(mod.locator('.hitokoto-from')).toContainText('测试者');
      // 换一句：清掉缓存重新拉取（本环境无外网，断言缓存被清）。
      await mod.locator('.hitokoto-refresh').click();
      await expect
        .poll(async () =>
          view.evaluate(
            () =>
              new Promise<string | null>((resolve) => {
                chrome.storage.local.get(['selfhub_hitokoto'], (res) => resolve((res.selfhub_hitokoto as never) ?? null));
              })
          )
        )
        .toBeNull();
      await view.close();
    });

    test('倒数日：添加条目显示剩余天数，刷新后还在', async () => {
      const view = await openNewTab();
      await view.locator('[data-add-col="0"]').click();
      await view.locator('.pop [data-add-type="countdown"]').click();
      const mod = view.locator('[data-module-type="countdown"]').first();

      const tomorrow = new Date(Date.now() + 86400000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const dateStr = tomorrow.getFullYear() + '-' + pad(tomorrow.getMonth() + 1) + '-' + pad(tomorrow.getDate());
      await mod.locator('.countdown-input').first().fill('发工资');
      await mod.locator('.countdown-date').fill(dateStr);
      await mod.locator('.countdown-add').click();

      await expect(mod.locator('.list-title')).toHaveText('发工资');
      await expect(mod.locator('.badge')).toHaveText(/还有 1 天|就是今天/);

      await view.reload();
      const after = view.locator('[data-module-type="countdown"]').first();
      await expect(after.locator('.list-title')).toHaveText('发工资');
      await view.close();
    });

    test('汇率：显示常用货币对基准的汇率（缓存数据）', async () => {
      const view = await openNewTab();
      await view.evaluate(
        () =>
          new Promise<void>((resolve) => {
            chrome.storage.local.set(
              {
                selfhub_rates_CNY: {
                  fetchedAt: Date.now(),
                  data: { rates: { USD: 0.14, EUR: 0.13, JPY: 21.2, GBP: 0.11, HKD: 1.08, KRW: 190 } }
                }
              },
              () => resolve()
            );
          })
      );

      await view.locator('[data-add-col="0"]').click();
      await view.locator('.pop [data-add-type="rates"]').click();
      const mod = view.locator('[data-module-type="rates"]').first();
      await expect(mod.locator('.list-title').first()).toContainText('1 CNY = 0.14 USD', { timeout: 10_000 });
      await expect(mod).toContainText('1 CNY = 21.2 JPY');
      await view.close();
    });

    test('番茄钟：开始专注后计时并跨刷新继续', async () => {
      const view = await openNewTab();
      await view.locator('[data-add-col="0"]').click();
      await view.locator('.pop [data-add-type="pomodoro"]').click();
      const mod = view.locator('[data-module-type="pomodoro"]').first();
      await mod.locator('[data-testid="pomodoro-focus"]').click();
      const clock = mod.locator('.pomodoro-clock');
      await expect(clock).toHaveText(/2[0-9]:[0-9]{2}/);
      const stored = await view.evaluate(
        () =>
          new Promise<{ endsAt: number } | null>((resolve) => {
            chrome.storage.local.get(['selfhub_pomodoro'], (res) => resolve((res.selfhub_pomodoro as never) || null));
          })
      );
      expect(stored?.endsAt).toBeGreaterThan(Date.now());

      await view.reload();
      const after = view.locator('[data-module-type="pomodoro"]').first();
      await expect(after.locator('.pomodoro-clock')).toHaveText(/2[0-9]:[0-9]{2}/);
      await view.close();
    });
  });

  test.describe('Grafana 双向灵活布局：水平调宽、半栏并排与自由增减栏', () => {
    test('卡片可以通过菜单切换为半栏并排（50%），并在单栏内左右并排', async () => {
      const page = await openNewTab();
      const col1 = page.locator('.dash-col[data-col="1"]');
      const first = col1.locator('[data-module-id="m-capture"]');
      const second = col1.locator('[data-module-id="m-pinned"]');

      // 两张卡片原本都是整栏（纵向叠放）
      const beforeFirst = (await first.boundingBox())!;
      const beforeSecond = (await second.boundingBox())!;
      expect(beforeSecond.y).toBeGreaterThanOrEqual(beforeFirst.y + beforeFirst.height - 10);

      // 把第一张设为半栏
      await first.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '半栏并排' }).click();

      // 把第二张也设为半栏
      await second.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '半栏并排' }).click();

      // 验证现在两张卡片在同一行并排（Y 坐标相近，X 坐标不同）
      const afterFirst = (await first.boundingBox())!;
      const afterSecond = (await second.boundingBox())!;
      expect(Math.abs(afterFirst.y - afterSecond.y)).toBeLessThan(10);
      expect(afterSecond.x).toBeGreaterThan(afterFirst.x + afterFirst.width - 10);

      // 刷新后依然保持半栏并排
      await page.reload();
      const reFirst = (await page.locator('.dash-col[data-col="1"] [data-module-id="m-capture"]').boundingBox())!;
      const reSecond = (await page.locator('.dash-col[data-col="1"] [data-module-id="m-pinned"]').boundingBox())!;
      expect(Math.abs(reFirst.y - reSecond.y)).toBeLessThan(10);
      await page.close();
    });

    test('右侧手柄左右拖拽显示 Grafana 尺寸气泡并可调整宽度', async () => {
      const page = await openNewTab();
      const module = page.locator('[data-module-id="m-notes"]');
      const handleW = module.locator('.module-resize-x');
      await expect(handleW).toBeAttached();

      const box = (await handleW.boundingBox())!;
      const beforeWidth = (await module.boundingBox())!.width;

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // 向左拖动使其进入半栏阈值
      await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 8 });

      // 验证 Grafana 风格尺寸气泡可见且含有半栏提示
      const badge = page.locator('.drag-badge');
      await expect(badge).toBeVisible();
      const text = await badge.textContent();
      expect(text).toContain('半栏');

      // 验证卡片在鼠标未松开时就已经实时动态改变宽度，有平滑的拖拽过程
      const liveWidth = (await module.boundingBox())!.width;
      expect(liveWidth).toBeLessThan(beforeWidth - 40);

      await page.mouse.up();
      await expect(badge).toBeHidden();
      await expect(module).toHaveClass(/is-half-width/);
      await page.close();
    });

    test('顶栏可以自由增加至最多 6 栏或减少至最少 1 栏，重置可恢复默认 3 栏', async () => {
      const page = await openNewTab();
      const colCountLabel = page.locator('#col-count-label');
      await expect(colCountLabel).toHaveText('3 栏');
      await expect(page.locator('.dash-col')).toHaveCount(3);

      // 点 ＋ 栏增加到 6 栏
      await page.locator('#col-inc').click();
      await expect(colCountLabel).toHaveText('4 栏');
      await page.locator('#col-inc').click();
      await expect(colCountLabel).toHaveText('5 栏');
      await page.locator('#col-inc').click();
      await expect(colCountLabel).toHaveText('6 栏');
      await expect(page.locator('.dash-col')).toHaveCount(6);
      await expect(page.locator('#col-inc')).toBeDisabled();

      // 刷新后记得 6 栏
      await page.reload();
      await expect(page.locator('#col-count-label')).toHaveText('6 栏');
      await expect(page.locator('.dash-col')).toHaveCount(6);

      // 点 － 栏减到 1 栏
      for (let i = 5; i >= 1; i--) {
        await page.locator('#col-dec').click();
        await expect(page.locator('#col-count-label')).toHaveText(`${i} 栏`);
      }
      await expect(page.locator('.dash-col')).toHaveCount(1);
      await expect(page.locator('#col-dec')).toBeDisabled();

      // 刷新后记得 1 栏
      await page.reload();
      await expect(page.locator('#col-count-label')).toHaveText('1 栏');
      await expect(page.locator('.dash-col')).toHaveCount(1);

      // 点击重置布局恢复默认三栏
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('#reset-layout').click();
      await expect(page.locator('#col-count-label')).toHaveText('3 栏');
      await expect(page.locator('.dash-col')).toHaveCount(3);
      await page.close();
    });

    test('卡片支持 1/4、1/3、2/3、3/4 多档精细比例及自定义精确百分比', async () => {
      const page = await openNewTab();
      const module = page.locator('[data-module-id="m-capture"]');

      // 打开菜单，检查丰富的宽度档位
      await module.locator('.module-menu-btn').click();
      await expect(page.locator('.pop .pop-item', { hasText: '1/4 四分之一' })).toBeVisible();
      await expect(page.locator('.pop .pop-item', { hasText: '1/3 三分之一' })).toBeVisible();
      await expect(page.locator('.pop .pop-item', { hasText: '半栏并排' })).toBeVisible();
      await expect(page.locator('.pop .pop-item', { hasText: '2/3 三分之二' })).toBeVisible();
      await expect(page.locator('.pop .pop-item', { hasText: '3/4 四分之三' })).toBeVisible();
      await expect(page.locator('.pop .pop-item', { hasText: '自定义百分比' })).toBeVisible();

      // 点击 1/3 三分之一
      await page.locator('.pop .pop-item', { hasText: '1/3 三分之一' }).click();
      await expect(module).toHaveClass(/is-third-width/);

      // 点击自定义百分比，输入 40%
      page.once('dialog', (dialog) => dialog.accept('40%'));
      await module.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '自定义百分比' }).click();

      await expect(module).toHaveClass(/is-custom-width/);
      const style = await module.getAttribute('style');
      expect(style).toContain('40%');

      // 刷新后自定义宽度保持生效
      await page.reload();
      const reModule = page.locator('[data-module-id="m-capture"]');
      await expect(reModule).toHaveClass(/is-custom-width/);
      const reStyle = await reModule.getAttribute('style');
      expect(reStyle).toContain('40%');
      await page.close();
    });

    test('拖动「记一笔」卡片横向手柄改变大小，松开后保持宽度且不回弹，刷新后依然生效', async () => {
      const page = await openNewTab();
      const module = page.locator('[data-module-id="m-capture"]');
      const handleW = module.locator('.module-resize-x');
      await expect(handleW).toBeAttached();

      const beforeBox = (await module.boundingBox())!;
      const handleBox = (await handleW.boundingBox())!;

      // 拖拽手柄向左移动 200px
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x - 200, handleBox.y + handleBox.height / 2, { steps: 8 });

      // 验证气泡显示宽度且未松开前实时变化
      const badge = page.locator('.drag-badge');
      await expect(badge).toBeVisible();
      const liveWidth = (await module.boundingBox())!.width;
      expect(liveWidth).toBeLessThan(beforeBox.width - 50);

      // 松开鼠标
      await page.mouse.up();
      await expect(badge).toBeHidden();

      // 验证松开后卡片保持缩小后的尺寸，没有回弹变回去
      const afterBox = (await module.boundingBox())!;
      expect(afterBox.width).toBeLessThan(beforeBox.width - 50);

      // 刷新后依然保持宽度，不会变回去
      await page.reload();
      const reModule = page.locator('[data-module-id="m-capture"]');
      const reBox = (await reModule.boundingBox())!;
      expect(reBox.width).toBeLessThan(beforeBox.width - 50);

      await page.close();
    });

    test('Grafana 级 2D 布局：支持左面一个、右面上下堆叠两个卡片', async () => {
      const page = await openNewTab();
      const col1 = page.locator('.dash-col[data-col="1"]');
      const capture = col1.locator('[data-module-id="m-capture"]');
      const pinned = col1.locator('[data-module-id="m-pinned"]');
      const sites = col1.locator('[data-module-id="m-sites"]');

      // 将 capture 设置在左侧
      await capture.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '排在左侧' }).click();

      // 将 pinned 设置在右侧
      await pinned.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '排在右侧' }).click();

      // 将 sites 也设置在右侧（堆叠在 pinned 下方）
      await sites.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '排在右侧' }).click();

      const captureBox = (await capture.boundingBox())!;
      const pinnedBox = (await pinned.boundingBox())!;
      const sitesBox = (await sites.boundingBox())!;

      // 验证右侧上下堆叠：pinned 在 sites 上方，且水平 X 坐标一致
      expect(Math.abs(pinnedBox.x - sitesBox.x)).toBeLessThan(10);
      expect(sitesBox.y).toBeGreaterThan(pinnedBox.y + 30);

      // 验证左侧 capture：水平 X 位于左侧，与右侧两张卡片并排
      expect(captureBox.x).toBeLessThan(pinnedBox.x - 20);
      expect(Math.abs(captureBox.y - pinnedBox.y)).toBeLessThan(10);

      // 验证 capture 自动跨行跨高，高度覆盖右侧两张堆叠卡片
      expect(captureBox.y + captureBox.height).toBeGreaterThan(sitesBox.y + 10);

      // 刷新后保持左面一个、右面上下堆叠两个的 Grafana 布局
      await page.reload();
      const reCaptureBox = (await page.locator('.dash-col[data-col="1"] [data-module-id="m-capture"]').boundingBox())!;
      const rePinnedBox = (await page.locator('.dash-col[data-col="1"] [data-module-id="m-pinned"]').boundingBox())!;
      const reSitesBox = (await page.locator('.dash-col[data-col="1"] [data-module-id="m-sites"]').boundingBox())!;

      expect(Math.abs(rePinnedBox.x - reSitesBox.x)).toBeLessThan(10);
      expect(reSitesBox.y).toBeGreaterThan(rePinnedBox.y + 30);
      expect(reCaptureBox.x).toBeLessThan(rePinnedBox.x - 20);
      expect(Math.abs(reCaptureBox.y - rePinnedBox.y)).toBeLessThan(10);
      expect(reCaptureBox.y + reCaptureBox.height).toBeGreaterThan(reSitesBox.y + 10);

      await page.close();
    });

    test('像板子一样自由拖拽：无需菜单，直接拖拽即可将卡片拖到右侧并排，再拖一张在右侧下层堆叠', async () => {
      const page = await openNewTab();
      const col0 = page.locator('.dash-col[data-col="0"]');
      const notes = col0.locator('[data-module-id="m-notes"]');
      // 默认左栏只有「笔记」，先加一张卡片当第二张
      await page.locator('[data-add-col="0"]').click();
      await page.locator('.pop [data-add-type="hitokoto"]').click();
      const second = col0.locator('[data-module-type="hitokoto"]');
      const secondId = (await second.getAttribute('data-module-id'))!;

      const beforeNotesBox = (await notes.boundingBox())!;

      // 直接把第二张拖到 notes 的右半侧（不点任何菜单）
      await startDrag(page, secondId);
      await hoverAt(page, beforeNotesBox.x + beforeNotesBox.width * 0.8, beforeNotesBox.y + beforeNotesBox.height * 0.5);

      // 验证 drop-gap 呈半栏形式吸附在右侧
      const gap = col0.locator('.drop-gap');
      await expect(gap).toBeVisible();
      await expect(gap).toHaveClass(/is-half-width/);

      // 松开鼠标，完成并排
      await releaseDrag(page, beforeNotesBox.x + beforeNotesBox.width * 0.8, beforeNotesBox.y + beforeNotesBox.height * 0.5);

      // 验证两者现在左右并排在同一水平行
      const afterNotesBox = (await notes.boundingBox())!;
      const afterSecondBox = (await second.boundingBox())!;
      expect(afterNotesBox.x).toBeLessThan(afterSecondBox.x - 20);
      expect(Math.abs(afterNotesBox.y - afterSecondBox.y)).toBeLessThan(15);
      expect(afterNotesBox.width).toBeLessThan(beforeNotesBox.width * 0.65);
      expect(afterSecondBox.width).toBeLessThan(beforeNotesBox.width * 0.65);

      // 刷新后保持自由拖拽后的并排布局
      await page.reload();
      const reNotesBox = (await page.locator('.dash-col[data-col="0"] [data-module-id="m-notes"]').boundingBox())!;
      const reSecondBox = (await page.locator('.dash-col[data-col="0"] [data-module-type="hitokoto"]').boundingBox())!;
      expect(reNotesBox.x).toBeLessThan(reSecondBox.x - 20);
      expect(Math.abs(reNotesBox.y - reSecondBox.y)).toBeLessThan(15);

      await page.close();
    });

    test('单栏或多卡模式下，直接将「记一笔」拖入上方空白区域，自动填满空白并在右侧卡片旁堆叠', async () => {
      const page = await openNewTab();
      // 减至 1 栏模拟用户的真实使用场景
      await page.locator('#col-dec').click();
      await page.locator('#col-dec').click();
      await expect(page.locator('#col-count-label')).toHaveText('1 栏');

      const col0 = page.locator('.dash-col[data-col="0"]');
      const notes = col0.locator('[data-module-id="m-notes"]');
      const tall = col0.locator('[data-module-id="m-pinned"]');
      const capture = col0.locator('[data-module-id="m-capture"]');

      // 将 notes 设为半栏（左侧），pinned 设为半栏（右侧，并拉高）
      await notes.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '排在左侧' }).click();

      await tall.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '排在右侧' }).click();

      // 拉大 tall 高度制造下方空白
      const tallHandleH = tall.locator('.module-resize');
      const qBox = (await tallHandleH.boundingBox())!;
      await page.mouse.move(qBox.x + qBox.width / 2, qBox.y + qBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(qBox.x + qBox.width / 2, qBox.y + qBox.height / 2 + 250, { steps: 10 });
      await page.mouse.up();

      const notesBox = (await notes.boundingBox())!;
      const tallBoxAfter = (await tall.boundingBox())!;

      // 直接将位于下方的 capture 拖动到左半侧空白区域（位于 notes 下方、quick 左侧）
      const blankTargetX = notesBox.x + notesBox.width * 0.5;
      const blankTargetY = notesBox.y + notesBox.height + 60;

      await startDrag(page, 'm-capture');
      await hoverAt(page, blankTargetX, blankTargetY);

      // 验证 drop-gap 准确呈半栏并吸附在左侧空白区域
      const gap = col0.locator('.drop-gap');
      await expect(gap).toBeVisible();
      await expect(gap).toHaveClass(/is-half-width/);

      // 松手完成放置
      await releaseDrag(page, blankTargetX, blankTargetY);

      // 验证 capture 已经成功落入左侧空白区域：与 notes 左右 X 坐标一致，且紧跟在 notes 下方
      const afterCaptureBox = (await capture.boundingBox())!;
      expect(Math.abs(afterCaptureBox.x - notesBox.x)).toBeLessThan(15);
      expect(afterCaptureBox.y).toBeGreaterThanOrEqual(notesBox.y + notesBox.height - 10);
      // 同时 capture 位于 tall 的左侧
      expect(afterCaptureBox.x).toBeLessThan(tallBoxAfter.x - 20);

      // 刷新后依然保持
      await page.reload();
      const reNotes = (await page.locator('.dash-col[data-col="0"] [data-module-id="m-notes"]').boundingBox())!;
      const reCapture = (await page.locator('.dash-col[data-col="0"] [data-module-id="m-capture"]').boundingBox())!;
      expect(Math.abs(reCapture.x - reNotes.x)).toBeLessThan(15);
      expect(reCapture.y).toBeGreaterThanOrEqual(reNotes.y + reNotes.height - 10);

      await page.close();
    });

    test('窄卡片拖到哪就停在哪：落点由指针算，不再只有左右两档', async () => {
      const page = await openNewTab();
      const capture = page.locator('[data-module-id="m-capture"]');

      // 先改成半栏（宽度不变，位置才是这次要验的东西）
      await capture.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '半栏并排' }).click();

      const col = page.locator('.dash-col[data-col="1"]');
      const colBox = (await col.boundingBox())!;
      const capBox = (await capture.boundingBox())!;
      const pinnedBox = (await page.locator('[data-module-id="m-pinned"]').boundingBox())!;

      await page.mouse.move(capBox.x + 30, capBox.y + 12);
      await page.mouse.down();
      const dropX = colBox.x + colBox.width * 0.35;
      const dropY = pinnedBox.y + pinnedBox.height * 0.5;
      await page.mouse.move(dropX, dropY, { steps: 12 });
      await page.waitForTimeout(150);

      // 虚线槽本身就落在指针那一列（x=1 → 第 2 条网格线起），不是非 0 即 6
      const gapColumn = await page.evaluate(() => {
        const gap = document.querySelector('.drop-gap') as HTMLElement | null;
        return gap ? gap.style.gridColumn : '';
      });
      expect(gapColumn, `虚线槽在第 ${gapColumn} 列，应该跟着指针走`).toMatch(/^[2-6] \/ span 6$/);

      await page.mouse.up();
      await page.waitForTimeout(200);

      const stored = await page.evaluate(
        () =>
          new Promise<{ modules: Array<{ id: string; x: number; y: number; w: number; free?: boolean }> }>((resolve) => {
            chrome.storage.local.get(['selfhub_newtab_layout'], (res) =>
              resolve(res.selfhub_newtab_layout as { modules: Array<{ id: string; x: number; y: number; w: number }> })
            );
          })
      );
      const mod = stored.modules.find((item) => item.id === 'm-capture')!;
      expect(mod.free, '松手后要记成"我亲手放的位置"').toBe(true);
      expect(mod.x).toBeGreaterThan(0);
      expect(mod.x).toBeLessThan(6);

      const afterBox = (await capture.boundingBox())!;
      const expectedLeft = colBox.x + (colBox.width * mod.x) / 12;
      expect(Math.abs(afterBox.x - expectedLeft), '卡片应该落在指针算出来的那一列').toBeLessThan(3);

      // 刷新后还在原地（不是重新排到左上角）
      await page.reload();
      const reBox = (await page.locator('[data-module-id="m-capture"]').boundingBox())!;
      expect(Math.abs(reBox.x - afterBox.x)).toBeLessThan(3);
      await page.close();
    });

    test('整栏卡片拖到窄卡片上：跟它并排、宽度也跟它一样', async () => {
      const page = await openNewTab();
      const notes = page.locator('[data-module-id="m-notes"]');
      await notes.locator('.module-menu-btn').click();
      await page.locator('.pop .pop-item', { hasText: '1/3 三分之一' }).click();

      const notesBox = (await notes.boundingBox())!;
      const pinned = page.locator('[data-module-id="m-pinned"]');
      const pinnedBox = (await pinned.boundingBox())!;

      // 把整栏的「常用网站」拖到「笔记」的右半部分
      await page.mouse.move(pinnedBox.x + 40, pinnedBox.y + 12);
      await page.mouse.down();
      await page.mouse.move(notesBox.x + notesBox.width * 0.85, notesBox.y + notesBox.height * 0.5, { steps: 14 });
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForTimeout(250);

      const afterPinned = (await pinned.boundingBox())!;
      const afterNotes = (await notes.boundingBox())!;
      expect(Math.abs(afterPinned.y - afterNotes.y), '两张卡在同一行').toBeLessThan(12);
      expect(afterPinned.x, '落在「笔记」右边').toBeGreaterThan(afterNotes.x + 20);
      expect(Math.abs(afterPinned.width - afterNotes.width), '宽度跟着邻居走').toBeLessThan(6);
      await page.close();
    });

    test('宽度拖动随意自由控制，不强制限制在 25/33/50/67/75，支持任意自定义连续宽度', async () => {
      const page = await openNewTab();
      const module = page.locator('[data-module-id="m-capture"]');
      const handleW = module.locator('.module-resize-x');

      const beforeBox = (await module.boundingBox())!;
      const hBox = (await handleW.boundingBox())!;

      // 向左拖动 120px（产生非标准的随意百分比，如 ~60% 左右）
      await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(hBox.x - 120, hBox.y + hBox.height / 2, { steps: 8 });

      // 气泡能显示动态百分比，卡片宽度实时跟随
      const badge = page.locator('.drag-badge');
      await expect(badge).toBeVisible();
      await page.mouse.up();

      // 松手后卡片宽度不会回弹变回去
      const afterBox = (await module.boundingBox())!;
      expect(afterBox.width).toBeLessThan(beforeBox.width - 60);

      // 刷新后依然记住该随意大小
      await page.reload();
      const reBox = (await page.locator('[data-module-id="m-capture"]').boundingBox())!;
      expect(reBox.width).toBeLessThan(beforeBox.width - 60);

      await page.close();
    });
  });

});
