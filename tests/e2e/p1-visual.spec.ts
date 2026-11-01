import { test, expect } from '@playwright/test';
import path from 'node:path';
import { seedState, baseState } from './helpers';

/**
 * P1-10 视觉检查：桌面与窄屏各截一批，集中复查。
 * Not a pixel-diff suite — it produces the images a human reviews once, which is
 * so an empty or crashed screen can never be filed as a screenshot.
 */

const OUT = path.join('docs', 'screenshots');

function richProfile() {
  const now = Date.now();
  return baseState({
    sites: [
      { id: 'v1', title: 'GitHub', url: 'https://github.com', category: '技术开发', pinned: true, visitCount: 42, createdAt: now },
      { id: 'v2', title: 'MDN Web Docs', url: 'https://developer.mozilla.org', category: '技术开发', pinned: true, visitCount: 31, createdAt: now },
      { id: 'v3', title: 'Cloudflare 控制台', url: 'https://dash.cloudflare.com', category: '运维部署', pinned: true, visitCount: 18, createdAt: now },
      { id: 'v4', title: 'V2EX', url: 'https://v2ex.com', category: '知识资讯', visitCount: 9, createdAt: now },
      { id: 'v5', title: 'DevDocs', url: 'https://devdocs.io', category: '常用工具', visitCount: 7, createdAt: now },
      { id: 'v6', title: 'Linux Command', url: 'https://wangchujiang.com/linux-command/', category: '常用工具', visitCount: 4, createdAt: now }
    ],
    notes: [
      {
        id: 'n1',
        title: '部署手册：边缘节点发布流程',
        content:
          '# 发布流程\n\n1. 本地跑通 `npm run build`\n2. 上传产物到对象存储\n3. 刷新缓存并验证健康检查\n\n> [!warning] 回滚\n> 保留上一版产物，出问题时先回滚再排查。\n\n```bash\nnpm run build && npm run deploy\n```\n',
        category: '运维',
        tags: ['发布', '部署'],
        updatedAt: now - 3600_000
      },
      { id: 'n2', title: '读书记录：分布式系统', content: '# 笔记\n\n一致性、可用性与分区容忍的取舍。', category: '学习', tags: ['分布式'], updatedAt: now - 86_400_000 }
    ],
    annotations: [
      {
        id: 'a1',
        pageTitle: '划词示例：什么是可用性',
        pageUrl: 'https://example.invalid/article',
        text: '可用性指的是系统在需要时可以被使用。',
        note: '和 CAP 里的 A 是一回事。',
        tags: ['分布式'],
        createdAt: now - 3_600_000,
        updatedAt: now - 3_600_000
      }
    ],
    inbox: [
      { id: 'i1', content: '把这段临时想法整理进项目文档', type: 'text', status: 'inbox', createdAt: now - 600_000 },
      { id: 'i2', content: 'https://example.invalid/article', type: 'url', url: 'https://example.invalid/article', status: 'inbox', createdAt: now - 1200_000 }
    ],
    reminders: [
      { id: 'r1', title: 'example.com 域名续费', category: 'domain', targetDate: now - 2 * 86_400_000, recurring: 'yearly', cost: '¥60 / 年', createdAt: now },
      { id: 'r2', title: '云主机续费', category: 'server', targetDate: now + 4 * 86_400_000, recurring: 'monthly', cost: '¥199 / 月', createdAt: now },
      { id: 'r3', title: '对象存储套餐', category: 'subscription', targetDate: now + 26 * 86_400_000, recurring: 'monthly', createdAt: now }
    ],
    servers: [
      { id: 'srv1', name: '生产主机', publicIp: '203.0.113.10', env: 'prod', sshUser: 'root', status: 'online', lastCheckedAt: now - 60_000, lastLatencyMs: 84, healthUrl: 'https://example.invalid/health', createdAt: now },
      { id: 'srv2', name: '测试主机', publicIp: '203.0.113.11', env: 'test', sshUser: 'deploy', status: 'unknown', createdAt: now }
    ],
    secrets: [
      { id: 'sec1', name: '对象存储 AccessKey', category: 'api_key', maskedPreview: 'LTAI••••••••0001', encryptedValue: 'AAAA', iv: 'BBBB', salt: 'CCCC', updatedAt: now },
      { id: 'sec2', name: '生产主机 SSH', category: 'ssh_key', maskedPreview: 'ssh-••••••••0002', encryptedValue: 'AAAA', iv: 'BBBB', salt: 'CCCC', updatedAt: now }
    ],
    handwritings: [],
    projects: [
      {
        id: 'p1',
        name: 'Self-Hub 改版',
        description: '把三个方向合并进一个工作台，先完成 P0 与 P1。',
        status: 'active',
        repoUrl: 'https://example.invalid/repo',
        tags: ['改版'],
        noteIds: ['n1', 'n-deleted'],
        serverIds: ['srv1'],
        reminderIds: ['r2'],
        decisions: [{ date: now - 86_400_000, title: '先复用旧组件再换底座', note: '避免外观与存储同时全量重写。' }],
        createdAt: now,
        updatedAt: now
      }
    ]
  });
}

async function capture(page: any, route: string, name: string, ready: (p: any) => Promise<void>) {
  await page.goto(route);
  await expect(page.locator('main')).toBeVisible();
  await ready(page);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

test.describe('P1-10 截图', () => {
  test('桌面端关键页面', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedState(page, richProfile());

    await capture(page, '/#/home', 'p1-desktop-home', async (p) => {
      await expect(p.getByTestId('home-view')).toBeVisible();
      await expect(p.locator('[data-home-block="sites"]')).toBeVisible();
    });
    await capture(page, '/#/navigation', 'p1-desktop-navigation', async (p) => {
      await expect(p.locator('[data-site-id]').first()).toBeVisible();
    });
    await capture(page, '/#/inbox', 'p1-desktop-inbox', async (p) => {
      await expect(p.locator('main')).toContainText('待整理');
    });
    await capture(page, '/#/library?type=webpage', 'p1-desktop-library', async (p) => {
      await expect(p.getByTestId('annotations-list')).toBeVisible();
    });
    await capture(page, '/#/library?view=notes', 'p1-desktop-notes', async (p) => {
      await expect(p.getByTestId('notes-workspace')).toBeVisible();
    });
    await capture(page, '/#/projects', 'p1-desktop-projects', async (p) => {
      await expect(p.locator('main')).toContainText('Self-Hub 改版');
    });
    await capture(page, '/#/reminders', 'p1-desktop-reminders', async (p) => {
      await expect(p.getByTestId('notification-strip')).toBeVisible();
    });
    await capture(page, '/#/resources/servers', 'p1-desktop-servers', async (p) => {
      await expect(p.locator('[data-server-status]').first()).toBeVisible();
    });
    await capture(page, '/#/resources/assets', 'p1-desktop-assets', async (p) => {
      // 域名 is its own collection now; the seeded 「域名续费」 reminder is migrated on boot,
      // so the table has content to show.
      await expect(p.getByTestId('domains-view')).toBeVisible();
      await expect(p.getByTestId('domain-table')).toBeVisible();
    });
    await capture(page, '/#/resources/vault', 'p1-desktop-vault-locked', async (p) => {
      await expect(p.getByTestId('vault-unlock')).toBeVisible();
    });
    await capture(page, '/#/settings/connections', 'p1-desktop-settings-connections', async (p) => {
      await expect(p.getByTestId('settings-page')).toBeVisible();
      await expect(p.locator('[data-integration="oss"]')).toBeVisible();
    });
    await capture(page, '/#/settings/storage', 'p1-desktop-settings-backup', async (p) => {
      await expect(p.getByTestId('settings-page')).toBeVisible();
    });
  });

  test('窄屏关键页面', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedState(page, richProfile());

    await capture(page, '/#/home', 'p1-narrow-home', async (p) => {
      await expect(p.getByTestId('home-view')).toBeVisible();
    });
    await capture(page, '/#/navigation', 'p1-narrow-navigation', async (p) => {
      await expect(p.locator('[data-site-id]').first()).toBeVisible();
    });
    await capture(page, '/#/library?type=webpage', 'p1-narrow-library', async (p) => {
      await expect(p.getByTestId('annotations-list')).toBeVisible();
    });
    await capture(page, '/#/reminders', 'p1-narrow-reminders', async (p) => {
      await expect(p.locator('main')).toBeVisible();
    });
    await capture(page, '/#/tools/checkins', 'p1-narrow-checkins', async (p) => {
      await expect(p.getByTestId('checkins-view')).toBeVisible();
    });
  });

  test('320px 极窄屏不溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await seedState(page, richProfile());
    await capture(page, '/#/home', 'p1-320-home', async (p) => {
      await expect(p.getByTestId('home-view')).toBeVisible();
    });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(overflow.scrollWidth <= overflow.clientWidth + 1).toBe(true);
  });
});
