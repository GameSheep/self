import { test, expect } from '@playwright/test';
import { resetApp, seedState, baseState, STORAGE_KEY } from './helpers';

/**
 * Replace the payload for the *next* navigation.
 *
 * `seedState` installs an init script that re-applies the original fixture on every
 * load, so writing localStorage in a running page and reloading is silently undone —
 * which made two of these tests assert against the wrong data. Registering another
 * init script (it runs after the first one) is the reliable way to change what the app
 * boots with.
 */
async function pushPayloadOnNextLoad(page: any, state: unknown) {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [STORAGE_KEY, JSON.stringify(state)] as const
  );
  await page.reload();
}

/**
 * P2 切库 phase 1: the HubState ⇄ v3 adapter.
 *
 * The app still reads the v2 payload, so this is not a switch yet — it is the evidence
 * that switching *could* be lossless. The round trip compares every record by id and
 * reports mismatches individually, because "some rows differ" is not a useful answer
 * when the thing at stake is the user's data.
 */

const LIBRARY = 'adapter-test';

function richState(overrides: Record<string, unknown> = {}) {
  return baseState({
    notes: [
      { id: 'n1', title: '笔记一', content: '# 正文\n\n内容', category: '知识', tags: ['a', 'b'], pinned: true, updatedAt: 111 },
      { id: 'n2', title: '笔记二', content: '第二篇', updatedAt: 222 }
    ],
    sites: [
      { id: 's1', title: '站点一', url: 'https://one.example.com', category: '工具', pinned: true, order: 2, visitCount: 7, tags: ['x'], createdAt: 5 },
      { id: 's2', title: '站点二', url: 'https://two.example.com', category: '常用', order: 1, createdAt: 6 }
    ],
    annotations: [
      {
        id: 'ann1',
        pageTitle: '文章标题',
        pageUrl: 'https://example.com/post',
        text: '划线的原文',
        note: '我的批注',
        color: 'yellow',
        tags: ['读'],
        anchor: { prefix: '前文', suffix: '后文', startOffset: 10, endOffset: 20 },
        projectId: 'p1',
        createdAt: 7,
        updatedAt: 8
      }
    ],
    wucaiHighlights: [
      { id: 'w1', pageTitle: '五彩网页', pageUrl: 'https://wucai.example.com', text: '五彩划线', color: 'green', createdAt: 9 }
    ],
    handwritings: [
      {
        id: 'hw1',
        title: '草图',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=',
        tags: ['画'],
        createdAt: 10
      }
    ],
    projects: [
      {
        id: 'p1',
        name: '项目一',
        description: '描述',
        status: 'active',
        repoUrl: 'https://github.com/example/repo',
        noteIds: ['n1', 'n2', 'n-missing'],
        siteIds: ['s1'],
        serverIds: ['srv1'],
        reminderIds: ['r1'],
        secretIds: ['sec1'],
        decisions: [{ date: 100, title: '决定', note: '备注' }],
        createdAt: 11,
        updatedAt: 12
      }
    ],
    servers: [
      {
        id: 'srv1',
        name: '主机一',
        domain: 'srv.example.com',
        publicIp: '203.0.113.9',
        internalIp: '10.0.0.9',
        port: 22,
        env: 'prod',
        sshUser: 'root',
        sshPort: 22,
        sshCommand: 'ssh root@203.0.113.9',
        healthUrl: 'https://srv.example.com/health',
        status: 'online',
        lastCheckedAt: 200,
        lastLatencyMs: 42,
        lastCheckMessage: 'HTTP 200',
        notes: '备注',
        expiresAt: 1_800_000_000_000,
        createdAt: 13
      }
    ],
    secrets: [
      {
        id: 'sec1',
        name: '令牌',
        category: 'api_key',
        encryptedValue: 'CIPHERTEXT-ABC',
        iv: 'iv-value',
        salt: 'salt-value',
        maskedPreview: 'sk-••••1234',
        description: '说明',
        tags: ['infra'],
        expiresAt: 1_900_000_000_000,
        updatedAt: 14
      }
    ],
    reminders: [
      {
        id: 'r1',
        title: '续费',
        category: 'domain',
        targetDate: 1_800_000_000_000,
        recurring: 'yearly',
        anchorDay: 15,
        cost: '¥99/年',
        url: 'https://example.com/renew',
        notes: '提前一周',
        completed: false,
        createdAt: 15,
        occurrences: [{ dueAt: 1_700_000_000_000, at: 1_700_100_000_000, action: 'renewed', nextDueAt: 1_800_000_000_000 }]
      }
    ],
    checkIns: [
      {
        id: 'c1',
        name: '签到',
        url: 'https://example.com/checkin',
        method: 'POST',
        type: 'http',
        enabled: true,
        lastRun: 300,
        lastStatus: 'success',
        history: [
          { at: 300, status: 'success', message: 'ok' },
          { at: 200, status: 'failed', message: 'timeout' }
        ],
        createdAt: 16
      }
    ],
    inbox: [
      { id: 'i1', content: '随手记', url: 'https://example.com', type: 'url', status: 'inbox', createdAt: 17 },
      { id: 'i2', content: '已转换', type: 'text', status: 'processed', targetType: 'note', targetId: 'n1', createdAt: 18 }
    ],
    obsidianNotes: [
      { key: 'vault/a.md', title: 'A', path: 'vault/a.md', size: 10, lastModified: 100, content: '# A' },
      { key: 'vault/b.md', title: 'B', path: 'vault/b.md', size: 20, lastModified: 200 }
    ],
    ...overrides
  });
}

test.describe('切库适配器（P2 phase 1）', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await resetApp(page);
  });

  test('全集合往返无损：按 id 逐条比对，没有任何差异', async ({ page }) => {
    await seedState(page, richState());
    await page.goto('/');

    const result = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.roundTrip(libraryId),
      LIBRARY
    );
    expect(result.ok, `差异：${JSON.stringify(result.diff)} / ${result.error ?? ''}`).toBe(true);
    expect(result.diff).toEqual([]);

    // The library really holds the records (not just "no diff" by accident).
    expect(result.counts?.notes).toBe(2);
    expect(result.counts?.sites).toBe(2);
    expect(result.counts?.annotations).toBe(2); // local + wucai
    expect(result.counts?.handwritings).toBe(1);
    expect(result.counts?.projects).toBe(1);
    expect(result.counts?.servers).toBe(1);
    expect(result.counts?.credentials).toBe(1);
    expect(result.counts?.reminders).toBe(1);
    expect(result.counts?.checkIns).toBe(1);
    expect(result.counts?.inbox).toBe(2);
    expect(result.counts?.obsidianNotes).toBe(2);
  });

  test('悬空引用被计数，但不会被伪造成实体', async ({ page }) => {
    await seedState(page, richState());
    await page.goto('/');

    const saved = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId),
      LIBRARY
    );
    expect(saved.ok, saved.error).toBe(true);
    // `noteIds` contains 'n-missing': one dangling link, reported not invented.
    expect(saved.report?.danglingLinks).toBe(1);
    expect(saved.report?.problems).toEqual([]);
    // Connections stay on the device and are named as such.
    expect(saved.report?.leftOnDevice.join(' ')).toContain('设备重新填写');
  });

  test('无法映射的记录会让整次写入失败，且不留下半个库', async ({ page }) => {
    await seedState(page, richState());
    await page.goto('/');
    const first = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId),
      LIBRARY
    );
    expect(first.ok, first.error).toBe(true);

    // A site without a URL cannot satisfy the v3 Bookmark shape.
    await pushPayloadOnNextLoad(page, {
      ...richState(),
      sites: [{ id: 'bad', title: '没有网址的站点', url: '', category: '工具', createdAt: 1 }]
    });

    const refused = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId),
      LIBRARY
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('无法写入 v3 模型');

    // The previous good library is untouched: same counts as the first write.
    const loaded = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.load(libraryId),
      LIBRARY
    );
    expect(loaded.ok, loaded.error).toBe(true);
    expect(loaded.counts?.notes).toBe(2);
    expect(loaded.counts?.sites).toBe(2);
  });

  test('显式允许丢弃时才继续，并在报告里写清楚丢了什么', async ({ page }) => {
    await seedState(page, richState());
    await page.goto('/');
    await pushPayloadOnNextLoad(page, {
      ...richState(),
      sites: [
        { id: 'good', title: '正常站点', url: 'https://ok.example.com', category: '工具', createdAt: 1 },
        { id: 'bad', title: '没有网址的站点', url: '', category: '工具', createdAt: 2 }
      ]
    });

    const allowed = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId, { allowDrop: true }),
      LIBRARY
    );
    expect(allowed.ok, allowed.error).toBe(true);
    expect(allowed.report?.dropped).toBeGreaterThan(0);
    // The report names the row and the reason, not just a count.
    expect(allowed.report?.problems.join(' ')).toContain('没有网址');
    // `save` reports per *store* (the write's own bookkeeping), so the bookmark count is
    // `bookmarks_v3` — only the bad row was dropped, the good one was written.
    expect(allowed.counts?.['bookmarks_v3']).toBe(1);
  });

  test('增量写入：只写改动的记录，删除只删消失的记录', async ({ page }) => {
    await seedState(page, richState());
    await page.goto('/');

    const first = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId),
      LIBRARY
    );
    expect(first.ok, first.error).toBe(true);
    // The first write has to write everything.
    expect(first.counts?.books ?? first.counts?.['bookmarks_v3']).toBeDefined();

    // Change one note's title only.
    await pushPayloadOnNextLoad(page, {
      ...richState(),
      notes: [
        { id: 'n1', title: '笔记一（改了标题）', content: '# 正文\n\n内容', category: '知识', tags: ['a', 'b'], pinned: true, updatedAt: 111 },
        { id: 'n2', title: '笔记二', content: '第二篇', updatedAt: 222 }
      ]
    });

    const second = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId),
      LIBRARY
    );
    expect(second.ok, second.error).toBe(true);
    // Only the changed note's item + body are written; nothing is deleted.
    expect(second.written?.['items_v3']).toBe(1);
    // The body did not change, so it must not be rewritten either.\r\n    expect(second.written?.['note_bodies_v3'] ?? 0).toBe(0);
    expect(second.written?.['bookmarks_v3']).toBe(0);
    expect(second.deleted?.['items_v3'] ?? 0).toBe(0);
    // …and the revision still advances, so a reader can tell something changed.
    expect(second.revision).toBe((first.revision ?? 0) + 1);

    // Remove a site: exactly one bookmark disappears, the rest is untouched.
    await pushPayloadOnNextLoad(page, {
      ...richState(),
      sites: [{ id: 's1', title: '站点一', url: 'https://one.example.com', category: '工具', pinned: true, order: 2, visitCount: 7, tags: ['x'], createdAt: 5 }]
    });
    const third = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId),
      LIBRARY
    );
    expect(third.ok, third.error).toBe(true);
    expect(third.deleted?.['bookmarks_v3']).toBe(1);
    expect(third.written?.['bookmarks_v3'] ?? 0).toBe(0);
    const remaining = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.load(libraryId),
      LIBRARY
    );
    expect(remaining.counts?.sites).toBe(1);
  });

  test('远端笔记正文进 blob，读回时不再只依赖 legacy', async ({ page }) => {
    await seedState(page, richState());
    await page.goto('/');
    const saved = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.save(libraryId),
      LIBRARY
    );
    expect(saved.ok, saved.error).toBe(true);
    // One cached remote body ('vault/a.md') becomes a blob record.
    expect(saved.counts?.['blobs_v3']).toBeGreaterThanOrEqual(2); // remote body + handwriting
    const loaded = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.load(libraryId),
      LIBRARY
    );
    const notes = (loaded.state as any).obsidianNotes;
    expect(notes.find((note: any) => note.key === 'vault/a.md')?.content).toBe('# A');
    expect(notes.find((note: any) => note.key === 'vault/b.md')?.content).toBeUndefined();
  });

  test('读回时连接配置仍来自本机，不会被库覆盖', async ({ page }) => {
    // The connection is part of the seeded payload on purpose: `seedState` re-applies the
    // fixture on every navigation, so writing it afterwards and reloading would be undone
    // by the init script (and the test would mistake that for "the library blanked it").
    await seedState(
      page,
      richState({
        obsidianConfig: {
          enabled: true,
          bucket: 'device-bucket',
          endpoint: 'oss-cn-test.aliyuncs.com',
          region: 'cn-test',
          accessKeyId: 'DEVICE-KEY-ID',
          accessKeySecret: 'DEVICE-SECRET',
          prefix: 'vault/'
        },
        features: { notes: false }
      } as Record<string, unknown>)
    );
    await page.goto('/');

    await page.evaluate((libraryId) => window.__selfhubContract!.library.save(libraryId), LIBRARY);
    const loaded = await page.evaluate(
      (libraryId) => window.__selfhubContract!.library.load(libraryId),
      LIBRARY
    );
    expect(loaded.ok, loaded.error).toBe(true);
    const state = loaded.state as any;
    expect(state.obsidianConfig.accessKeySecret).toBe('DEVICE-SECRET');
    expect(state.features.notes).toBe(false);
    // …and the business data came from the library.
    expect(state.notes).toHaveLength(2);
  });
});
