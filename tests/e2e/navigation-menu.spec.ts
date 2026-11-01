import { test, expect, Page, BrowserContext } from '@playwright/test';
import { baseState, readState, seedState, STORAGE_KEY } from './helpers';

/**
 * P1-04 — 快捷导航：菜单不误开链接、排序稳定、站内筛选不外发。
 *
 * The seeded state uses explicit `order` values so a reorder has a deterministic
 * starting point (no timestamps involved).
 */
const SEED_SITES = [
  { id: 'site-a', title: '站点甲', url: 'https://a.example.com/', category: '技术开发', visitCount: 1, createdAt: 1000, order: 0 },
  { id: 'site-b', title: '站点乙', url: 'https://b.example.com/', category: '技术开发', visitCount: 2, createdAt: 2000, order: 1 },
  { id: 'site-c', title: '站点丙', url: 'https://c.example.com/', category: '效率工具', visitCount: 3, createdAt: 3000, order: 0 }
];

/**
 * Matches only real engine hosts. A loose /google\.com/ would also match the
 * dev-server URL (`127.0.0.1:5173` contains no "google" today, but "baidu"
 * style substrings are exactly the kind of false positive that turns a
 * "no external request" assertion into a lie).
 */
const ENGINE_PATTERN = /\/\/(www\.)?(google|bing|baidu)\.com\//;

/**
 * Collects every request the browser engine sees (including aborted ones) and
 * aborts engine requests, so a leak is both recorded and harmless. Assertions
 * read the recorded list — never `route.abort()` side effects.
 */
async function trackEngineRequests(context: BrowserContext) {
  const requests: string[] = [];
  context.on('request', (request) => {
    if (ENGINE_PATTERN.test(request.url())) requests.push(request.url());
  });
  await context.route(ENGINE_PATTERN, (route) => route.abort());
  return requests;
}

async function seedNavigation(page: Page) {
  await seedState(page, baseState({ sites: SEED_SITES, categories: ['全部', '技术开发', '效率工具'] }));
}

/**
 * Seed without `addInitScript`.
 * `seedState`'s init script re-runs on *every* navigation inside the context, so
 */
async function seedNavigationByHand(page: Page) {
  const payload = JSON.stringify(
    baseState({ sites: SEED_SITES, categories: ['全部', '技术开发', '效率工具'] })
  );
  await page.goto('/#/navigation');
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
      window.localStorage.setItem('selfhub_onboarded', '1');
    },
    [STORAGE_KEY, payload] as const
  );
  await page.reload();
  await expect(pageHeading(page)).toBeVisible();
}

/** The page heading lives in `#main`; the TopBar has a nav item with the same text. */
const pageHeading = (page: Page) => page.locator('#main').getByRole('heading', { name: '快捷导航' });

async function gotoNavigation(page: Page) {
  await page.goto('/#/navigation');
  await expect(pageHeading(page)).toBeVisible();
}

function card(page: Page, siteId: string) {
  return page.locator(`[data-site-id="${siteId}"]`);
}

/** Rendered titles in DOM order. */
async function renderedTitles(page: Page): Promise<string[]> {
  return page.locator('[data-testid="site-title"]').allInnerTexts();
}

async function openMenu(page: Page, siteId: string) {
  await card(page, siteId).getByTestId('site-menu-button').click();
  const menu = page.getByTestId('site-menu');
  await expect(menu).toBeVisible();
  return menu;
}

const localFilter = (page: Page) => page.getByLabel(/在快捷导航中筛选/);

test.describe('快捷导航：打开与管理不冲突', () => {
  test('⋯ 菜单里的删除不会打开网站链接', async ({ page, context }) => {
    const engineRequests = await trackEngineRequests(context);
    const externalNavigations: string[] = [];
    const popups: Page[] = [];

    // If a management click ever escaped into window.open / a navigation, the
    // target is an external host and lands here. Passive favicon <img> loads are
    // not navigations — cards render auto-recognized icons since the icon
    // redesign — so they pass through uncounted.
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('http://127.0.0.1:') || url.startsWith('data:') || url.startsWith('blob:')) {
        await route.continue();
        return;
      }
      if (url.includes('/favicon.ico')) {
        await route.abort('blockedbyclient');
        return;
      }
      externalNavigations.push(url);
      await route.abort('blockedbyclient');
    });
    page.on('popup', (popup) => {
      popups.push(popup);
    });

    await seedNavigation(page);
    await gotoNavigation(page);

    const menu = await openMenu(page, 'site-a');
    await menu.getByRole('menuitem', { name: '删除' }).click();

    // Destructive actions ask first, naming the site and what disappears.
    const confirm = page.getByRole('dialog', { name: /删除「站点甲」/ });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('https://a.example.com/');
    await expect(confirm).toContainText('无法撤销');

    await confirm.getByRole('button', { name: '删除这个网站' }).click();

    await expect.poll(async () => (await readState(page)).sites.length).toBe(2);
    await expect(card(page, 'site-a')).toHaveCount(0);
    // Give a wrongly-issued window.open time to surface before asserting.
    await page.waitForTimeout(700);

    expect(popups, '点击菜单删除不应打开任何新页面').toHaveLength(0);
    expect(externalNavigations, '点击菜单删除不应发起任何外部导航').toHaveLength(0);
    expect(engineRequests, '点击菜单删除不应访问搜索引擎').toHaveLength(0);
  });

  test('⋯ 菜单里的复制链接不会打开网站，并用行内状态报告成功', async ({ page }) => {
    const popups: Page[] = [];
    page.on('popup', (popup) => popups.push(popup));

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => undefined }
      });
    });

    await seedNavigation(page);
    await gotoNavigation(page);

    const menu = await openMenu(page, 'site-b');
    await menu.getByRole('menuitem', { name: '复制链接' }).click();

    const notice = page.getByRole('status').filter({ hasText: '已复制' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('站点乙');
    await page.waitForTimeout(300);
    expect(popups, '复制链接不应打开网站').toHaveLength(0);
  });

  test('键盘激活 ⋯ 按钮不会打开网站', async ({ page }) => {
    const popups: Page[] = [];
    page.on('popup', (popup) => popups.push(popup));

    await seedNavigation(page);
    await gotoNavigation(page);

    await card(page, 'site-a').getByTestId('site-menu-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('site-menu')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('site-menu')).toHaveCount(0);

    // Space toggles it too, which is the other key that activates a button.
    await page.keyboard.press(' ');
    await expect(page.getByTestId('site-menu')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.waitForTimeout(400);
    expect(popups, '键盘激活菜单不应打开网站').toHaveLength(0);
  });

  test('单击卡片正文会打开网址（新页面）并记录访问', async ({ page, context }) => {
    await trackEngineRequests(context);
    await seedNavigation(page);
    await gotoNavigation(page);

    const popupPromise = page.waitForEvent('popup');
    await card(page, 'site-c').getByTestId('site-title').click();
    const popup = await popupPromise;

    expect(popup).toBeTruthy();
    await expect.poll(async () => (await readState(page)).sites.find((s: any) => s.id === 'site-c')?.visitCount).toBe(4);
    await popup.close();
  });
});

test.describe('快捷导航：稳定排序与非拖拽替代', () => {
  test('上移改变渲染顺序，order 持久化并在刷新后保留', async ({ page }) => {
    await seedNavigationByHand(page);

    expect(await renderedTitles(page)).toEqual(['站点甲', '站点乙', '站点丙']);

    const menu = await openMenu(page, 'site-b');
    await menu.getByRole('menuitem', { name: '上移' }).click();

    await expect.poll(async () => renderedTitles(page)).toEqual(['站点乙', '站点甲', '站点丙']);

    const persisted = await readState(page);
    const byId = new Map(persisted.sites.map((s: any) => [s.id, s]));
    // Real numbers are written and they are contiguous: one move leaves no gap.
    expect(byId.get('site-b')!.order).toBe(0);
    expect(byId.get('site-a')!.order).toBe(1);
    // The other group is untouched, and nothing was duplicated.
    expect(byId.get('site-c')!.order).toBe(0);
    expect(persisted.sites.length).toBe(3);

    await page.reload();
    await expect(pageHeading(page)).toBeVisible();
    expect(await renderedTitles(page)).toEqual(['站点乙', '站点甲', '站点丙']);

    // The order in storage is the same one that was rendered after the reload.
    const reloaded = await readState(page);
    const reloadedById = new Map(reloaded.sites.map((s: any) => [s.id, s]));
    expect(reloadedById.get('site-b')!.order).toBe(0);
    expect(reloadedById.get('site-a')!.order).toBe(1);
  });

  test('移动到分组会把网站排到目标分组末尾，并保留全部记录', async ({ page }) => {
    await seedNavigation(page);
    await gotoNavigation(page);

    const menu = await openMenu(page, 'site-b');
    await menu.getByRole('menuitem', { name: '移动到分组' }).click();

    const dialog = page.getByRole('dialog', { name: '移动到分组' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: '移动' }).click();

    await expect
      .poll(async () => (await readState(page)).sites.find((s: any) => s.id === 'site-b')?.category)
      .toBe('效率工具');

    const state = await readState(page);
    expect(state.sites.length).toBe(3);
    const moved = state.sites.find((s: any) => s.id === 'site-b');
    expect(moved.order).toBe(1); // 站点丙 is 0; the moved site lands after it.
    expect(state.sites.find((s: any) => s.id === 'site-a')?.order).toBe(0);
  });

  test('分组边界上的上移/下移是禁用状态', async ({ page }) => {
    await seedNavigation(page);
    await gotoNavigation(page);

    const first = await openMenu(page, 'site-a');
    await expect(first.getByRole('menuitem', { name: '上移' })).toBeDisabled();
    await expect(first.getByRole('menuitem', { name: '下移' })).toBeEnabled();
    await page.keyboard.press('Escape');

    const last = await openMenu(page, 'site-b');
    await expect(last.getByRole('menuitem', { name: '下移' })).toBeDisabled();
    await expect(last.getByRole('menuitem', { name: '上移' })).toBeEnabled();
  });

  test('置顶写入持久状态，刷新后仍保留', async ({ page }) => {
    await seedNavigationByHand(page);

    const menu = await openMenu(page, 'site-b');
    await menu.getByRole('menuitem', { name: '置顶' }).click();

    await expect.poll(async () => (await readState(page)).sites.find((s: any) => s.id === 'site-b')?.pinned).toBe(true);
    await page.reload();
    await expect(pageHeading(page)).toBeVisible();
    await expect(card(page, 'site-b')).toHaveAttribute('data-pinned', 'true');
  });
});

test.describe('快捷导航：站内筛选与外部搜索分离', () => {
  test('在站内筛选里输入不会发出任何搜索引擎请求', async ({ page, context }) => {
    const engineRequests = await trackEngineRequests(context);

    await seedNavigation(page);
    await gotoNavigation(page);

    await localFilter(page).fill('站点丙');

    // Result is local: only the matching card remains.
    await expect(card(page, 'site-c')).toHaveCount(1);
    await expect(card(page, 'site-a')).toHaveCount(0);
    await expect(page.getByText('这里输入的内容只在本机筛选')).toBeVisible();

    // Even pressing Enter here must not reach an engine.
    await localFilter(page).press('Enter');
    await page.waitForTimeout(700);

    expect(engineRequests, '站内筛选不应发出搜索引擎请求').toHaveLength(0);
    expect(page.url()).toContain('#/navigation');
  });

  test('站内筛选会匹配描述与标签，不只是标题', async ({ page }) => {
    await seedState(
      page,
      baseState({
        categories: ['全部', '技术开发'],
        sites: [
          {
            id: 'site-desc',
            title: '内部平台',
            url: 'https://internal.example.com/',
            category: '技术开发',
            description: '团队看板与发布入口',
            tags: ['看板', 'deploy'],
            createdAt: 1000,
            order: 0
          },
          { id: 'site-other', title: '新闻站', url: 'https://news.example.com/', category: '技术开发', createdAt: 2000, order: 1 }
        ]
      })
    );
    await gotoNavigation(page);

    await localFilter(page).fill('发布入口');
    await expect(card(page, 'site-desc')).toHaveCount(1);
    await expect(card(page, 'site-other')).toHaveCount(0);

    await localFilter(page).fill('deploy');
    await expect(card(page, 'site-desc')).toHaveCount(1);
    await expect(card(page, 'site-other')).toHaveCount(0);
  });

  test('外部搜索必须显式触发，并且只访问所选引擎', async ({ page, context }) => {
    const engineRequests = await trackEngineRequests(context);

    await seedNavigation(page);
    await gotoNavigation(page);

    await page.getByText('去网上搜索', { exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Google' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Bing' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '百度' })).toBeVisible();
    await expect(page.getByText(/关键词会发送到该搜索引擎的外部网站/)).toBeVisible();

    await page.getByRole('tab', { name: '百度' }).click();

    const popupPromise = page.waitForEvent('popup');
    await page.getByTestId('web-search-input').fill('self hub 测试');
    await page.getByTestId('web-search-submit').click();
    const popup = await popupPromise;

    // The popup's own URL is a chrome-error page because the engine route aborts
    // the navigation, so assert on the request the browser actually issued.
    await expect.poll(() => engineRequests.length).toBeGreaterThan(0);
    const baiduRequest = engineRequests.find((url) => url.includes('baidu.com'));
    expect(baiduRequest, '显式触发外部搜索应请求所选引擎').toBeTruthy();
    expect(decodeURIComponent(baiduRequest!)).toContain('self hub 测试');
    expect(engineRequests.every((url) => url.includes('baidu.com')), '不应访问其它搜索引擎').toBe(true);
    await popup.close();
  });

  test('在外部搜索框按回车会使用当前引擎', async ({ page, context }) => {
    const engineRequests = await trackEngineRequests(context);

    await seedNavigation(page);
    await gotoNavigation(page);

    await page.getByText('去网上搜索', { exact: true }).click();
    await page.getByRole('tab', { name: 'Bing' }).click();
    const popupPromise = page.waitForEvent('popup');
    await page.getByTestId('web-search-input').fill('playwright');
    await page.getByTestId('web-search-input').press('Enter');

    const popup = await popupPromise;
    await expect.poll(() => engineRequests.length).toBeGreaterThan(0);
    expect(engineRequests[0]).toContain('bing.com');
    expect(engineRequests[0]).toContain('playwright');
    await popup.close();
  });
});

test.describe('快捷导航：可用性', () => {
  test('没有网站时给出空状态和下一步动作', async ({ page }) => {
    await seedState(page, baseState({ sites: [], categories: ['全部'] }));
    await gotoNavigation(page);

    await expect(page.getByText('还没有保存任何网站')).toBeVisible();
    await expect(page.getByRole('button', { name: '添加第一个网站' })).toBeVisible();
    await expect(page.getByTestId('open-bookmark-import')).toBeVisible();
  });

  test('通过内联对话框新建网站（不经过通用录入弹窗）', async ({ page }) => {
    await seedState(page, baseState({ sites: [], categories: ['全部'] }));
    await gotoNavigation(page);

    await page.getByRole('button', { name: '添加第一个网站' }).click();
    const dialog = page.getByRole('dialog', { name: '新建网站' });
    await dialog.getByLabel('名称').fill('新建站点');
    await dialog.getByLabel('网址').fill('new.example.com');
    await dialog.getByLabel('分组').fill('测试分组');
    await dialog.getByRole('button', { name: '保存网站' }).click();

    await expect.poll(async () => (await readState(page)).sites.length).toBe(1);
    const site = (await readState(page)).sites[0];
    expect(site.title).toBe('新建站点');
    expect(site.url).toBe('https://new.example.com');
    expect(site.category).toBe('测试分组');
    await expect(card(page, site.id)).toHaveCount(1);
  });

  test('窄屏（320px）下不会出现页面级横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await seedNavigation(page);
    await gotoNavigation(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('宽屏使用更密的网格（≥1200px 至少 4 列）', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await seedNavigation(page);
    await gotoNavigation(page);

    const columns = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="site-grid"]');
      if (!grid) return 0;
      return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    });
    expect(columns).toBeGreaterThanOrEqual(4);
  });
});
