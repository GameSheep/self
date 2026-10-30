import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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

    await page.reload();
    const reloaded = (await page.locator('.dash-col[data-col="0"]').boundingBox())!;
    expect(Math.abs(reloaded.width - after.width)).toBeLessThan(6);
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
