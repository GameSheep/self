import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, gotoTab, readState } from './helpers';

/**
 * 域名 (6.2) — the bug this replaces.
 * 域名 used to be a *projection* over 提醒, so the page's only action was 「新建到期提醒」 and
 */
test.describe('域名', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('域名页有自己的记录与表单，不会再跳到提醒页', async ({ page }) => {
    await resetApp(page);
    await gotoTab(page, '域名与订阅');

    // The page is the domain list, not a reminder projection.
    await expect(page.getByTestId('domains-view')).toBeVisible();
    await expect(page.getByTestId('domain-count')).toHaveText('0');

    await page.getByTestId('domain-add').click();
    await page.getByTestId('domain-name').fill('https://Example.COM/path');
    await page.getByTestId('domain-start').fill('2025-03-01');
    await page.getByTestId('domain-expire').fill('2027-03-01');
    await page.getByTestId('domain-registrar').fill('阿里云');
    await page.getByTestId('domain-dns').fill('ns1.aliyun.com');
    await page.getByTestId('domain-save').click();

    // Still on the domain page — the old bug navigated to #/reminders here.
    await expect(page).not.toHaveURL(/#\/reminders/);
    await expect(page.getByTestId('domain-table')).toContainText('example.com');

    const saved: any = await readState(page);
    expect(saved.domains).toHaveLength(1);
    expect(saved.domains[0]).toMatchObject({
      name: 'example.com',
      registrar: '阿里云',
      dns: 'ns1.aliyun.com'
    });
    expect(new Date(saved.domains[0].startAt).getFullYear()).toBe(2025);
    expect(new Date(saved.domains[0].expireAt).getFullYear()).toBe(2027);
    // No reminder was invented: the domain is its own record.
    expect(saved.reminders).toHaveLength(0);
  });

  test('原有的「域名续费」提醒会被复制成域名记录，提醒本身保留', async ({ page }) => {
    await seedState(
      page,
      baseState({
        reminders: [
          {
            id: 'r-domain',
            title: 'legacy-site.com',
            category: 'domain',
            targetDate: Date.now() + 20 * 86_400_000,
            url: 'https://legacy-site.com/renew',
            createdAt: 1
          }
        ]
      })
    );
    await page.goto('/#/resources/assets');
    await expect(page.getByTestId('domain-table')).toContainText('legacy-site.com');

    const saved: any = await readState(page);
    expect(saved.domains).toHaveLength(1);
    expect(saved.domains[0].name).toBe('legacy-site.com');
    expect(saved.domains[0].url).toBe('https://legacy-site.com/renew');
    // The reminder survives: deleting it would change what 「今天要处理」 shows.
    expect(saved.reminders).toHaveLength(1);
  });

  test('可以编辑与删除，搜索按域名/注册商/DNS 命中', async ({ page }) => {
    await seedState(
      page,
      baseState({
        domains: [
          { id: 'd1', name: 'alpha.com', registrar: 'Cloudflare', dns: 'ns1.cloudflare.com', createdAt: 1 },
          { id: 'd2', name: 'beta.net', registrar: '阿里云', createdAt: 1 }
        ]
      })
    );
    await page.goto('/#/resources/assets');
    await expect(page.getByTestId('domain-count')).toHaveText('2');

    // Search matches registrar and DNS, not only the name.
    await page.getByTestId('domain-search').fill('cloudflare');
    await expect(page.getByTestId('domain-table')).toContainText('alpha.com');
    await expect(page.getByTestId('domain-table')).not.toContainText('beta.net');
    await page.getByTestId('domain-search').fill('');

    // Edit the registrar.
    await page.getByTestId('domain-edit-d2').click();
    await page.getByTestId('domain-registrar').fill('腾讯云');
    await page.getByTestId('domain-save').click();
    await expect.poll(async () => (await readState(page)).domains.find((d: any) => d.id === 'd2')?.registrar).toBe('腾讯云');

    // Delete one — 两击确认（首击只武装按钮，这是 data-safety 的下限约定）。
    const del = page.getByTestId('domain-delete-d1');
    await del.click();
    await expect(del).toHaveAttribute('data-armed', 'true');
    await del.click();
    await expect.poll(async () => (await readState(page)).domains.length).toBe(1);
  });
});

test.describe('凭据按网站分组', () => {
  test('同一个网站可以有多条凭据，未指定网站的单独成组', async ({ page }) => {
    await seedState(
      page,
      baseState({
        secrets: [
          {
            id: 's1',
            name: 'GitHub 只读 token',
            category: 'token',
            website: 'github.com',
            encryptedValue: 'AAAA',
            iv: 'BBBB',
            salt: 'CCCC',
            maskedPreview: 'gh••0001',
            updatedAt: 1
          },
          {
            id: 's2',
            name: 'GitHub admin token',
            category: 'token',
            website: 'github.com',
            encryptedValue: 'AAAA',
            iv: 'BBBB',
            salt: 'CCCC',
            maskedPreview: 'gh••0002',
            updatedAt: 1
          },
          {
            id: 's3',
            name: '无网站凭据',
            category: 'api_key',
            encryptedValue: 'AAAA',
            iv: 'BBBB',
            salt: 'CCCC',
            maskedPreview: 'sk••0003',
            updatedAt: 1
          }
        ]
      })
    );
    await page.goto('/#/resources/vault');
    // A locked vault renders no list at all — that is the contract, so unlock first.
    await page.getByTestId('vault-unlock').click();
    const inputs = page.locator('input[type="password"]');
    await inputs.first().fill('grouping-pass');
    if ((await inputs.count()) > 1) await inputs.nth(1).fill('grouping-pass');
    await page.locator('button', { hasText: /完成设置并开启金库|立即解锁/ }).click();

    await expect(page.getByTestId('vault-groups')).toBeVisible();
    await expect(page.locator('[data-vault-site="github.com"]')).toContainText('2 条');
    await expect(page.locator('[data-vault-site=""]')).toContainText('未指定网站');
  });
});
