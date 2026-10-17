import { test, expect } from '@playwright/test';
import { seedState, baseState } from './helpers';

/**
 * Server health must be probed, not assumed.
 *
 * New servers used to be created with `status: 'online'`, so the dashboard's
 * "N/M 运行中" was fiction.
 */

function state(servers: any[]) {
  return baseState({ servers });
}

const baseServer = {
  env: 'prod',
  publicIp: '10.0.0.1',
  sshUser: 'root',
  createdAt: Date.now()
};

async function mockHealth(page: any) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.includes('example.com')) {
      await route.continue();
      return;
    }
    if (url.includes('ok.example.com')) {
      await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
      return;
    }
    if (url.includes('auth.example.com')) {
      await route.fulfill({ status: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      return;
    }
    if (url.includes('down.example.com')) {
      await route.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'boom' });
      return;
    }
    await route.continue();
  });
}

test.describe('服务器健康检测', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('新建的服务器默认是"未探测"，不会假装在线', async ({ page }) => {
    await mockHealth(page);
    await seedState(page, state([{ ...baseServer, id: 's1', name: '新服务器', status: 'unknown' }]));
    await page.goto('/');
    await page.locator('nav button', { hasText: '自研部署与主机' }).click();

    await expect(page.locator('[data-server-status="unknown"]')).toBeVisible();
    await expect(page.locator('[data-server-status="online"]')).toHaveCount(0);
  });

  test('检测成功后显示在线并保存延迟', async ({ page }) => {
    await mockHealth(page);
    await seedState(
      page,
      state([
        { ...baseServer, id: 's1', name: '健康节点', status: 'unknown', healthUrl: 'https://ok.example.com/ping' }
      ])
    );
    await page.goto('/');
    await page.locator('nav button', { hasText: '自研部署与主机' }).click();

    await page.locator('button', { hasText: '检测' }).first().click();
    await expect(page.locator('[data-server-status="online"]')).toBeVisible({ timeout: 15_000 });

    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return raw ? JSON.parse(raw).servers[0] : null;
    });
    expect(saved.status).toBe('online');
    expect(saved.lastCheckedAt).toBeGreaterThan(0);
    expect(saved.lastCheckMessage).toContain('200');
  });

  test('401 也算在线（服务可达但没有权限）', async ({ page }) => {
    await mockHealth(page);
    await seedState(
      page,
      state([
        { ...baseServer, id: 's1', name: '需鉴权', status: 'unknown', healthUrl: 'https://auth.example.com/' }
      ])
    );
    await page.goto('/');
    await page.locator('nav button', { hasText: '自研部署与主机' }).click();
    await page.locator('button', { hasText: '检测' }).first().click();

    await expect(page.locator('[data-server-status="online"]')).toBeVisible({ timeout: 15_000 });
  });

  test('HTTP 5xx 判定为不可达', async ({ page }) => {
    await mockHealth(page);
    await seedState(
      page,
      state([
        { ...baseServer, id: 's1', name: '故障节点', status: 'unknown', healthUrl: 'https://down.example.com/' }
      ])
    );
    await page.goto('/');
    await page.locator('nav button', { hasText: '自研部署与主机' }).click();
    await page.locator('button', { hasText: '检测' }).first().click();

    await expect(page.locator('[data-server-status="offline"]')).toBeVisible({ timeout: 15_000 });
  });

  test('没有可探测地址时保持"未探测"并说明原因', async ({ page }) => {
    await mockHealth(page);
    await seedState(page, state([{ ...baseServer, id: 's1', name: '只有 IP', status: 'unknown' }]));
    await page.goto('/');
    await page.locator('nav button', { hasText: '自研部署与主机' }).click();
    await page.locator('button', { hasText: '检测' }).first().click();

    await expect(page.locator('[data-server-status="unknown"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('main')).toContainText('没有可用于探测的地址');
  });

  test('全部检测会更新每一台', async ({ page }) => {
    await mockHealth(page);
    await seedState(
      page,
      state([
        { ...baseServer, id: 's1', name: '好节点', status: 'unknown', healthUrl: 'https://ok.example.com/' },
        { ...baseServer, id: 's2', name: '坏节点', status: 'unknown', healthUrl: 'https://down.example.com/' }
      ])
    );
    await page.goto('/');
    await page.locator('nav button', { hasText: '自研部署与主机' }).click();
    await page.locator('button', { hasText: '全部检测' }).click();

    await expect(page.locator('[data-server-status="online"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('[data-server-status="offline"]')).toHaveCount(1, { timeout: 20_000 });
  });

  test('新建服务器可填写健康检查 URL，并保存为未探测', async ({ page }) => {
    await mockHealth(page);
    await seedState(page, state([]));
    await page.goto('/');
    await page.locator('nav button', { hasText: '自研部署与主机' }).click();

    await page.locator('button', { hasText: '添加服务' }).click();
    await expect(page.getByText('录入新资产')).toBeVisible();
    await page.locator('div.fixed.inset-0 button', { hasText: '部署' }).click();
    await page.waitForTimeout(200);

    const visible = async (sel: string) => {
      const els = await page.locator(sel).all();
      for (const el of els) if (await el.isVisible()) return el;
      return null;
    };
    (await visible('input[placeholder="例如: 生产核心服务节点"]'))!.fill('探测节点');
    (await visible('input[placeholder="1.2.3.4"]'))!.fill('10.0.0.9');
    const health = await visible('input[placeholder="https://api.example.com/health"]');
    expect(health, '应存在健康检查 URL 输入框').toBeTruthy();
    await health!.fill('https://ok.example.com/health');
    await page.locator('div.fixed.inset-0 button', { hasText: '保存资产' }).click();

    await expect.poll(async () => {
      return page.evaluate(() => {
        const raw = localStorage.getItem('self_hub_data_v2');
        return raw ? JSON.parse(raw).servers.length : 0;
      });
    }).toBe(1);

    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem('self_hub_data_v2');
      return JSON.parse(raw).servers[0];
    });
    expect(saved.healthUrl).toBe('https://ok.example.com/health');
    expect(saved.status).toBe('unknown');
  });

  test('仪表盘只把探测为在线的计入', async ({ page }) => {
    await mockHealth(page);
    await seedState(
      page,
      state([
        { ...baseServer, id: 's1', name: '好节点', status: 'online', healthUrl: 'https://ok.example.com/' },
        { ...baseServer, id: 's2', name: '未探测', status: 'unknown' }
      ])
    );
    await page.goto('/');
    await expect(page.locator('main')).toContainText('1/2 在线');
    await expect(page.locator('main')).toContainText('1 未探测');
  });
});
