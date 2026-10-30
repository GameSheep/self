import { test, expect } from '@playwright/test';
import { seedState, baseState, gotoTab, readState, visible } from './helpers';

/**
 * 服务器归类 + 凭据多字段 + 抽屉式新建表单.
 *
 * 三个真实使用痛点：
 * 1. 新建服务器/凭据时，居中全屏遮罩把后面的列表挡得死死的——而填表恰恰要参照已有条目。
 *    新契约：右侧抽屉，页面其余部分保持可见、可读、未被遮挡。
 * 2. 一个网站常有多台主机（web/db/cdn），平铺网格让它们看起来毫无关系。
 *    新契约：按「归属网站/项目」自由文本分组展示，分组可以事后在卡片上改。
 * 3. 一套凭据往往是 key + secret 两截，过去只能拆成两条。
 *    新契约：一条凭据带多个字段，每个字段独立加密、独立查看/复制。
 */

const NOW = Date.now();

test.describe('服务器与凭据重设计', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
  });

  test('新建服务器时抽屉不遮挡后面的列表，且可填归属分组', async ({ page }) => {
    await seedState(
      page,
      baseState({
        servers: [
          { id: 's1', name: '已有节点', env: 'prod', publicIp: '10.0.0.1', sshUser: 'root', createdAt: NOW }
        ]
      })
    );
    await page.goto('/');
    await gotoTab(page, '服务器');

    await page.locator('button', { hasText: '添加服务器' }).first().click();
    await expect(page.getByTestId('add-item-modal')).toBeVisible();

    // 关键契约：抽屉打开时，后面的服务器卡片要么仍是可点击的最顶层元素，
    // 要么隔着的只是一层完全透明的遮罩——内容必须看得见，而不是被黑色蒙层盖住。
    const card = page.locator('[data-server-row="s1"]');
    await expect(card).toBeVisible();
    const seeThrough = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top) return false;
      if (top === el || el.contains(top) || top.contains(el)) return true;
      const bg = getComputedStyle(top).backgroundColor;
      return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
    });
    expect(seeThrough, '抽屉打开时服务器卡片应透过透明遮罩可见').toBe(true);

    await visible(page, 'input[placeholder="例如: 生产核心服务节点"]').fill('新节点');
    await visible(page, 'input[placeholder="1.2.3.4"]').fill('10.0.0.9');
    await visible(page, '[data-server-field="group"]').fill('官网');
    await page.getByTestId('add-item-submit').click();

    await expect
      .poll(async () => (await readState(page)).servers.find((s: any) => s.name === '新节点')?.group)
      .toBe('官网');
  });

  test('服务器按归属分组展示，未分组在最后，且可在卡片上改归属', async ({ page }) => {
    await seedState(
      page,
      baseState({
        servers: [
          { id: 's1', name: 'web-1', env: 'prod', publicIp: '1.1.1.1', group: '官网', createdAt: NOW },
          { id: 's2', name: 'db-1', env: 'prod', publicIp: '1.1.1.2', group: '官网', createdAt: NOW },
          { id: 's3', name: 'misc', env: 'dev', publicIp: '2.2.2.2', createdAt: NOW }
        ]
      })
    );
    await page.goto('/');
    await gotoTab(page, '服务器');

    const official = page.locator('[data-server-group="官网"]');
    await expect(official).toBeVisible();
    await expect(official.locator('[data-server-row]')).toHaveCount(2);

    const ungrouped = page.locator('[data-server-group=""]');
    await expect(ungrouped).toBeVisible();
    await expect(ungrouped.locator('[data-server-row]')).toHaveCount(1);
    // 未分组标题读作「未分组」（h3 需要限定在分组头部，卡片标题也是 h3）。
    await expect(ungrouped.locator('h3').first()).toHaveText('未分组');

    // 事后改归属：把 s3 挪进「官网」。
    await page.getByTestId('server-group-edit-s3').click();
    const form = page.getByTestId('server-group-form-s3');
    await expect(form).toBeVisible();
    await form.locator('input[name="group"]').fill('官网');
    await form.locator('button[type="submit"]').click();

    await expect
      .poll(async () => (await readState(page)).servers.find((s: any) => s.id === 's3')?.group)
      .toBe('官网');
    await expect(page.locator('[data-server-group="官网"] [data-server-row]')).toHaveCount(3);
  });

  test('凭据支持多字段：key 和 secret 存一条，逐字段查看', async ({ page }) => {
    // 预置一条旧版单值凭据，验证兼容：没有 fields 时卡片照常渲染掩码。
    await seedState(
      page,
      baseState({
        secrets: [
          {
            id: 'sec-legacy',
            name: '旧版凭据',
            category: 'api_key',
            encryptedValue: 'AAAA',
            iv: 'BBBB',
            salt: 'CCCC',
            maskedPreview: 'sk-old-••••1234',
            updatedAt: NOW
          }
        ]
      })
    );

    // 设置主密码并解锁金库。
    await gotoTab(page, '凭证金库');
    await page.getByTestId('vault-unlock').click();
    const passwordInputs = page.locator('input[type="password"]');
    await passwordInputs.first().fill('test-master-123');
    if ((await passwordInputs.count()) > 1) await passwordInputs.nth(1).fill('test-master-123');
    await page.locator('button', { hasText: /完成设置并开启金库|立即解锁/ }).click();
    await expect(page.getByTestId('vault-search')).toBeVisible({ timeout: 10_000 });

    // 旧版凭据的掩码照常显示。
    await expect(page.locator('main')).toContainText('sk-old-••••1234');

    // 新建一条双字段凭据。
    await page.locator('button', { hasText: '新建凭据' }).first().click();
    await expect(page.getByTestId('add-item-modal')).toBeVisible();
    await visible(page, 'input[placeholder*="Gemini"]').fill('阿里云 OSS');
    await visible(page, '[data-secret-field="label-0"]').fill('Access Key ID');
    await visible(page, 'input[data-secret-field="value-0"]').fill('LTAI5tEXAMPLEkeyid');
    await page.getByTestId('secret-add-field').click();
    await visible(page, '[data-secret-field="label-1"]').fill('Access Key Secret');
    await visible(page, 'input[data-secret-field="value-1"]').fill('sekrit-EXAMPLE-4567');
    await page.getByTestId('add-item-submit').click();

    await expect
      .poll(async () => (await readState(page)).secrets.length)
      .toBe(2);

    const saved = (await readState(page)).secrets.find((s: any) => s.name === '阿里云 OSS');
    expect(saved.fields, '应保存为多字段结构').toHaveLength(2);
    expect(saved.fields[0].label).toBe('Access Key ID');
    expect(saved.fields[1].label).toBe('Access Key Secret');
    // 旧字段形状同步写入（取第一个字段），备份/全局搜索等旧读者不受影响。
    expect(saved.encryptedValue).toBeTruthy();
    expect(saved.encryptedValue).not.toContain('LTAI5tEXAMPLE');
    expect(saved.maskedPreview).toContain('••');
    expect(JSON.stringify(saved)).not.toContain('sekrit-EXAMPLE');

    // 逐字段查看：字段名显示为行标题，且只作用于这条凭据自己的卡片。
    const card = page.locator(`[data-secret-card="${saved.id}"]`);
    await expect(card.locator('[data-secret-field-row="Access Key ID"]')).toBeVisible();
    // 点击后按钮 title 变成「隐藏明文」，因此用字段行来定位，而不是按序号。
    await card.locator('[data-secret-field-row="Access Key ID"] button[title="查看明文"]').click();
    await expect(card).toContainText('LTAI5tEXAMPLEkeyid');
    await card.locator('[data-secret-field-row="Access Key Secret"] button[title="查看明文"]').click();
    await expect(card).toContainText('sekrit-EXAMPLE-4567');
  });
});
