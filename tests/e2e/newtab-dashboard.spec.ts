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

async function openNewTab(seed: typeof SEED = SEED): Promise<Page> {
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

test.describe('拖动反馈：幽灵卡片 + 虚线槽（Grafana 手感）', () => {
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

    // 点分类 chip 会走 dashboard.render()，整页 DOM 重建 —— 这是用户会遇到的
    // "我明明打了字，它自己没了"。工作台恢复备份后 adopt() 也是同一条路。
    await page.locator('[data-module-id="m-sites"] .bucket-chip').first().click();
    await expect(input).toHaveValue(draft);
  });

  test('加一个文本框，写的内容直接变成一条笔记', async () => {
    const page = await openNewTab();

    // 左栏底部「＋ 添加模块」→ 文本框
    await page.locator('[data-add-col="0"]').click();
    await page.locator('.pop [data-add-type="quicknote"]').click();

    const box = page.locator('[data-module-type="quicknote"]').last();
    await expect(box).toBeVisible();
    const text = `新标签页写的想法-${Date.now()}`;
    await box.locator('#quicknote-input').fill(text);
    await box.locator('#quicknote-save').click();
    await expect(box.locator('#quicknote-status')).toHaveText('已存进笔记');

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
    expect(stored!.modules.find((m) => m.id === 'm-sites')?.source).toEqual({ mode: 'bucket', value: 'AI' });
    await page.close();
  });

  test('文本框写的笔记，打开工作台就在笔记里（队列导入一次即清空）', async () => {
    test.setTimeout(90_000);
    freshBuild();
    const page = await openNewTab();
    await page.locator('[data-add-col="0"]').click();
    await page.locator('.pop [data-add-type="quicknote"]').click();
    const box = page.locator('[data-module-type="quicknote"]').last();
    const text = `跨页面笔记-${Date.now()}`;
    await box.locator('#quicknote-input').fill(text);
    await box.locator('#quicknote-save').click();
    await expect(box.locator('#quicknote-status')).toHaveText('已存进笔记');

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
   *
   * 原因是记一笔走 `CAPTURE_ENTRY`，写的是扩展自己的 v3 收件箱
   * （`selfhub_extension` 库），而工作台读的是另一套存储；桥接层当时还在读
   * 一个早就不写了的老 key `chrome.storage.local.selfhub_inbox`。所以它确实
   * 存下来了，只是存到了一个没人看的地方。
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
});
