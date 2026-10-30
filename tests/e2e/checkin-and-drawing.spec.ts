import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, readState } from './helpers';

/**
 * 7.1 签到站点与 7.2 手绘形状.
 *
 * 签到: supported sites are a catalogue — a site only appears as a task once it has been
 * configured, which is what "没选择配置就不显示" means.
 * 手绘: the canvas is bigger and can draw rectangles / ellipses / lines, not just freehand.
 */
test.describe('签到：只显示已配置的站点', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('未配置的支持站点不出现在清单里，点一下才加入', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState());
    await page.goto('/#/tools/checkins');
    await page.reload();

    // Empty list, and the catalogue is only a hint — not the list itself.
    await expect(page.getByTestId('checkins-view')).toContainText('还没有签到网站');
    await expect(page.getByTestId('checkin-catalog')).toContainText('常见签到站点');
    await page.getByTestId('checkin-catalog-bilibili').click();

    await expect.poll(async () => (await readState(page)).checkIns?.length).toBe(1);
    const saved: any = await readState(page);
    expect(saved.checkIns[0]).toMatchObject({ name: '哔哩哔哩', type: 'redirect', enabled: false });

    // Now it is a task: visible as a card, and no longer offered in the catalogue.
    await expect(page.locator('[data-testid="checkins-view"]')).toContainText('哔哩哔哩');
    await expect(page.getByTestId('checkin-catalog-bilibili')).toHaveCount(0);
  });

  test('已配置的站点不会在支持清单里重复出现', async ({ page }) => {
    await seedState(
      page,
      baseState({
        checkIns: [
          {
            id: 'c1',
            name: '阿里云盘',
            url: 'https://www.aliyundrive.com/signin',
            method: 'GET',
            type: 'redirect',
            enabled: false,
            createdAt: 1
          }
        ]
      })
    );
    await page.goto('/#/tools/checkins');
    await expect(page.getByTestId('checkin-catalog-aliyundrive')).toHaveCount(0);
  });
});

test.describe('手绘：更大的画布与形状工具', () => {
  test('画布更大，并且有矩形/椭圆/直线工具', async ({ page }) => {
    await resetApp(page);
    await seedState(page, baseState());
    await page.goto('/#/tools/drawing');

    const canvas = page.getByTestId('drawing-canvas');
    await expect(canvas).toBeVisible();
    // Bigger than the old 800×320 board.
    const size = await canvas.evaluate((el) => ({
      width: (el as HTMLCanvasElement).width,
      height: (el as HTMLCanvasElement).height,
      cssHeight: el.getBoundingClientRect().height
    }));
    expect(size.width).toBeGreaterThanOrEqual(1600);
    expect(size.height).toBeGreaterThanOrEqual(900);
    expect(size.cssHeight).toBeGreaterThan(300);

    for (const tool of ['pen', 'rect', 'ellipse', 'line']) {
      await expect(page.locator(`[data-tool="${tool}"]`)).toBeVisible();
    }
  });

  test('拖出一个矩形就能保存（不再只能手写）', async ({ page }) => {
    await seedState(page, baseState());
    await page.goto('/#/tools/drawing');

    await page.locator('[data-tool="rect"]').click();
    const canvas = page.getByTestId('drawing-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 180, { steps: 6 });
    await page.mouse.up();

    // The shape counts as content: saving must not refuse with "empty canvas".
    await page.getByPlaceholder(/给这幅手绘命名/).fill('矩形测试');
    await page.getByTestId('handwriting-save').click();
    await expect.poll(async () => (await readState(page)).handwritings?.length ?? 0).toBe(1);
    const savedImage = (await readState(page)).handwritings[0].dataUrl;
    expect(savedImage.startsWith('data:image/png')).toBe(true);
  });
});
