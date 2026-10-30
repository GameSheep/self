/**
 * End-to-end round trip through a real provider transport (P2-05).
 *
 * `backupSuite.ts` proves the format against an in-memory transport. This suite
 * proves the same protocol survives an actual `BackupTransport` implementation —
 * signing, PROPFIND, MKCOL, DELETE, error mapping — which is where the P1 clients
 * live and where "works with a mock" stops being evidence.
 *
 * Provider-agnostic on purpose: the same steps run for OSS and WebDAV, so a
 * difference between them shows up as a failing step rather than as two
 * hand-written test files that slowly drift apart.
 */
import type { BackupTransport } from './transport';
import { collectSnapshot } from './snapshot';
import { listGenerations, pruneGenerations, readGeneration, writeGeneration } from './writer';
import { resolveLatestGeneration } from './resolve';
import { describeResolvedLatest } from './latest';
import type { HubState } from '../../types';

export interface ProviderStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProviderRoundTripOptions {
  transport: BackupTransport;
  libraryId: string;
  deviceId: string;
  password: string;
  /** Non-secret label for the report (e.g. bucket or DAV URL). */
  label: string;
  state?: HubState;
  now?: () => number;
}

export interface ProviderRoundTripReport {
  label: string;
  steps: ProviderStep[];
  /** Object count left behind by the run (0 after cleanup). */
  leftovers: number;
  wrote: number;
  removed: number;
  /** What the settings page would show as "will be restored by default". */
  latestDescription: string;
}

function minimalState(): HubState {
  return {
    theme: 'dark',
    categories: [],
    sites: [
      { id: 'site-1', title: '示例站点', url: 'https://example.com', category: '默认', createdAt: 1 }
    ],
    servers: [],
    secrets: [],
    checkIns: [],
    reminders: [{ id: 'rem-1', title: '续费', category: 'domain', targetDate: 1_800_000_000_000, createdAt: 1 }],
    notes: [{ id: 'note-1', title: '笔记', content: '# 正文', updatedAt: 1 }],
    handwritings: [],
    obsidianNotes: [],
    obsidianConfig: {
      enabled: false,
      bucket: '',
      endpoint: '',
      region: '',
      accessKeyId: '',
      accessKeySecret: '',
      prefix: ''
    },
    aiConfig: { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' },
    cloudflareSync: { enabled: false, workerUrl: '', syncKey: '', autoSync: false },
    webdavConfig: { enabled: false, url: '', username: '', password: '', pathPrefix: '' }
  } as HubState;
}

export async function runProviderRoundTrip(options: ProviderRoundTripOptions): Promise<ProviderRoundTripReport> {
  const steps: ProviderStep[] = [];
  const now = options.now ?? (() => Date.now());
  const state = options.state ?? minimalState();
  let wrote = 0;
  let removed = 0;
  let latestDescription = '';

  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      steps.push({ name, ok: true });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
  };

  const countObjects = async (prefix: string): Promise<number> => (await options.transport.list(prefix)).length;

  const write = (generationId: string, at: number) =>
    writeGeneration({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      contentRevision: 3,
      password: options.password,
      snapshot: collectSnapshot(state),
      now: () => at,
      generationId
    });

  await step('通过真实传输写入批次并逐对象回读校验', async () => {
    const result = await write('gen-provider-1', now());
    assert(result.ok, `写入失败：${result.ok ? '' : result.error.userMessage}`);
    if (!result.ok) return;
    wrote = result.value.objectCount;
    assert(result.value.verified === 'full', '应完成完整回读校验');
    assert(result.value.warnings.length === 0, `不应有告警：${result.value.warnings.join('；')}`);
  });

  await step('列目录能看出批次已完成，并能解析本设备默认恢复源', async () => {
    const listed = await listGenerations({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      password: options.password
    });
    assert(listed.ok, `列目录失败：${listed.ok ? '' : listed.error.userMessage}`);
    if (!listed.ok) return;
    assert(listed.value.length === 1, `应列出 1 个批次，实际 ${listed.value.length}`);
    assert(listed.value[0].complete, '批次应标记为已完成');
    assert(listed.value[0].counts?.['笔记'] === 1, '清单计数应可读回');

    const resolved = await resolveLatestGeneration({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      password: options.password
    });
    assert(resolved.ok, '解析默认恢复源不应失败');
    if (!resolved.ok) return;
    assert(resolved.value.source === 'pointer', `应通过指针解析，实际 ${resolved.value.source}`);
    assert(resolved.value.generationId === 'gen-provider-1', '默认恢复源应是刚写入的批次');
    latestDescription = describeResolvedLatest(resolved.value);
    assert(latestDescription.includes('gen-provider-1'), `用户可见说明应指出批次：${latestDescription}`);
  });

  await step('读回批次内容并通过对象哈希校验', async () => {
    const read = await readGeneration({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      generationId: 'gen-provider-1',
      password: options.password
    });
    assert(read.ok, `读取失败：${read.ok ? '' : read.error.userMessage}`);
    if (!read.ok) return;
    assert(read.value.issues.length === 0, `对象校验应无问题：${read.value.issues.join('；')}`);
    assert(read.value.manifest.counts['收藏'] === 1, '清单应包含 1 个收藏');
    assert(read.value.manifest.exclusions.length > 0, '应带范围说明');
  });

  await step('第二次写入后指针前移，旧批次保持只读', async () => {
    const result = await write('gen-provider-2', now() + 60_000);
    assert(result.ok, `第二次写入失败：${result.ok ? '' : result.error.userMessage}`);
    const resolved = await resolveLatestGeneration({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      password: options.password
    });
    assert(resolved.ok && resolved.value.generationId === 'gen-provider-2', '指针应指向第二个批次');
    const first = await readGeneration({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      generationId: 'gen-provider-1',
      password: options.password,
      verifyObjects: false
    });
    assert(first.ok, '旧批次仍应可读');
  });

  await step('保留策略按对象逐个删除旧批次，并保护指针批次', async () => {
    const pruned = await pruneGenerations({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId,
      now: now() + 60_000,
      keepLast: 1,
      keepDays: 0
    });
    assert(pruned.ok, `清理失败：${pruned.ok ? '' : pruned.error.userMessage}`);
    if (!pruned.ok) return;
    assert(pruned.value.removed.includes('gen-provider-1'), `应清理旧批次，实际 ${JSON.stringify(pruned.value.removed)}`);
    assert(!pruned.value.removed.includes('gen-provider-2'), '指针所指批次不应被清理');
    removed = pruned.value.removed.length;

    const remaining = await listGenerations({
      transport: options.transport,
      libraryId: options.libraryId,
      deviceId: options.deviceId
    });
    assert(remaining.ok, '清理后仍应能列目录');
    if (!remaining.ok) return;
    assert(remaining.value.length === 1, `清理后应只剩 1 个批次，实际 ${remaining.value.length}`);
    assert(remaining.value[0].generationId === 'gen-provider-2', '剩下的应是指针批次');
  });

  await step('能读回完成标记并清空本设备的备份目录', async () => {
    const objects = await options.transport.list(`.selfhub/v3/${options.libraryId}/${options.deviceId}/`);
    assert(objects.length > 0, '清理前应还有对象');
    for (const object of objects) {
      await options.transport.remove(object.path);
    }
    const after = await countObjects(`.selfhub/v3/${options.libraryId}/${options.deviceId}/`);
    assert(after === 0, `清理后不应留下对象，实际 ${after}`);
  });

  const leftovers = await countObjects(`.selfhub/v3/${options.libraryId}/${options.deviceId}/`);
  return { label: options.label, steps, leftovers, wrote, removed, latestDescription };
}
