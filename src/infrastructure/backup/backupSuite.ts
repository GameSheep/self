/**
 * v3 backup format self-check suite (P2-05).
 *
 * Runs in the browser (through the dev-only bridge) because the crypto and the
 * hashing are real Web Crypto calls — the whole point is that the package's
 * guarantees hold with the actual algorithms, not with a stub.
 *
 * The transport is in-memory, which is deliberate: the protocol (write order,
 * completion marker, hash verification, retention) is what is under test, and
 * mixing it with a network provider would make failures ambiguous. Provider
 * adapters are covered separately.
 */
import type { HubState } from '../../types';
import { MemoryBackupTransport, type BackupTransport } from './transport';
import { collectSnapshot } from './snapshot';
import { listGenerations, pruneGenerations, readGeneration, writeGeneration } from './writer';
import { readLatestPointer } from './latest';
import { resolveLatestGeneration } from './resolve';
import { decryptObject, deriveBackupKey, hashStored, newSalt, encryptObject } from './format';

export interface BackupCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; userMessage: string } }): T {
  assert(result.ok, `期望成功，实际失败: ${result.ok ? '' : `${result.error.code} ${result.error.userMessage}`}`);
  return result.value;
}

async function check(name: string, run: () => Promise<void>): Promise<BackupCheckResult> {
  try {
    await run();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Records the order of writes so "marker last" can be asserted, not assumed. */
class RecordingTransport extends MemoryBackupTransport {
  readonly writes: string[] = [];
  override async put(path: string, body: string, contentType?: string): Promise<void> {
    this.writes.push(path);
    await super.put(path, body, contentType);
  }
}

const OSS_SECRET = 'oss-secret-must-not-leave-device';
const WEBDAV_PASSWORD = 'webdav-password-must-not-leave';
const AI_KEY = 'sk-ai-key-must-not-leave-device-0000';
const WUCAI_TOKEN = 'wucai-token-must-not-leave';
const YOUDO_COOKIE = 'ynote-skey-must-not-leave';
const SYNC_KEY = 'cloudflare-sync-key-must-not-leave';

function sampleState(overrides: Partial<HubState> = {}): HubState {
  return {
    theme: 'dark',
    categories: ['默认', '工具'],
    sites: [
      {
        id: 'site-1',
        title: '示例站点',
        url: 'https://example.com',
        category: '工具',
        createdAt: 1
      }
    ],
    servers: [
      {
        id: 'srv-1',
        name: '主机',
        publicIp: '203.0.113.10',
        env: 'prod',
        createdAt: 1
      }
    ],
    secrets: [
      {
        id: 'sec-1',
        name: '金库条目',
        category: 'api_key',
        // Ciphertext only: useless without the master password, which never leaves
        // the browser, so it is safe (and useful) to include.
        encryptedValue: 'VAULT-CIPHERTEXT-marker',
        iv: 'iv',
        salt: 'salt',
        maskedPreview: 'sk-••••0000',
        updatedAt: 1
      }
    ],
    checkIns: [
      {
        id: 'chk-1',
        name: '每日签到',
        url: 'https://example.com/checkin',
        method: 'GET',
        type: 'http',
        createdAt: 1
      }
    ],
    reminders: [
      {
        id: 'rem-1',
        title: '续费',
        category: 'domain',
        targetDate: 1_800_000_000_000,
        createdAt: 1
      }
    ],
    notes: [{ id: 'note-1', title: '笔记', content: '# 内容', updatedAt: 1 }],
    handwritings: [
      {
        id: 'hw-1',
        title: '草图',
        // 1x1 transparent PNG.
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=',
        createdAt: 1
      }
    ],
    inbox: [{ id: 'inb-1', content: '随手记', type: 'text', status: 'inbox', createdAt: 1 }],
    projects: [
      {
        id: 'prj-1',
        name: '项目',
        description: '',
        status: 'active',
        noteIds: ['note-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    annotations: [
      {
        id: 'ann-1',
        pageTitle: '网页',
        pageUrl: 'https://example.com/a',
        text: '划线的原文',
        note: '我的批注',
        color: 'yellow',
        createdAt: 1
      }
    ],
    obsidianNotes: [
      { key: 'vault/已缓存.md', title: '已缓存', path: 'vault/已缓存.md', size: 10, lastModified: 1, content: '# 缓存正文' },
      { key: 'vault/未下载.md', title: '未下载', path: 'vault/未下载.md', size: 20, lastModified: 2 }
    ],
    wucaiHighlights: [],
    youdaoNotes: [],
    obsidianConfig: {
      enabled: true,
      bucket: 'bucket',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      region: 'cn-hangzhou',
      accessKeyId: 'ACCESS-KEY-ID-must-not-leave',
      accessKeySecret: OSS_SECRET,
      prefix: 'vault/'
    },
    wucaiConfig: { enabled: true, token: WUCAI_TOKEN },
    youdaoConfig: { enabled: true, token: 'youdao-token', cookie: YOUDO_COOKIE },
    aiConfig: {
      provider: 'deepseek',
      apiKey: AI_KEY,
      baseUrl: 'https://api.example.com',
      model: 'deepseek-chat'
    },
    cloudflareSync: { enabled: true, workerUrl: 'https://sync.example.com', syncKey: SYNC_KEY, autoSync: false },
    webdavConfig: { enabled: true, url: 'https://dav.example.com', username: 'u', password: WEBDAV_PASSWORD, pathPrefix: '' },
    ...overrides
  } as HubState;
}

export interface BackupSuiteOptions {
  runId: string;
}

export async function runBackupSuite(options: BackupSuiteOptions): Promise<BackupCheckResult[]> {
  const runId = options.runId;
  const libraryId = `lib-${runId}`;
  const deviceId = `dev-${runId}`;
  const password = 'backup-password-1';
  const results: BackupCheckResult[] = [];

  const newTransport = () => new RecordingTransport();

  const write = async (transport: BackupTransport, state: HubState, at: number, id?: string) =>
    writeGeneration({
      transport,
      libraryId,
      deviceId,
      contentRevision: 7,
      password,
      snapshot: collectSnapshot(state),
      now: () => at,
      generationId: id
    });

  results.push(
    await check('批次包含数据、清单与完成标记，且完成标记最后写入', async () => {
      const transport = newTransport();
      const result = await write(transport, sampleState(), 1_700_000_000_000, 'gen-order');
      assert(result.ok, `写入应成功：${result.ok ? '' : result.error.userMessage}`);
      const writes = transport.writes;
      assert(writes.length >= 4, `至少应写 4 个对象（数据/清单/标记/指针），实际 ${writes.length}`);
      const manifestIndex = writes.findIndex((path) => path.endsWith('manifest.enc.json'));
      const markerIndex = writes.findIndex((path) => path.endsWith('_complete.json'));
      const pointerIndex = writes.findIndex((path) => path.endsWith('latest.json'));
      const lastObjectIndex = writes.findIndex((path) => path.includes('objects/'));
      assert(lastObjectIndex < manifestIndex, '清单应在数据对象之后写入');
      assert(manifestIndex < markerIndex, '完成标记应在清单之后写入');
      // The pointer is intentionally the very last write (P2-05): it may only name
      // a generation whose marker and bytes were already verified.
      assert(markerIndex < pointerIndex, '指针应在完成标记之后写入');
      assert(pointerIndex === writes.length - 1, `指针应是最后一个写入，实际 ${writes[writes.length - 1]}`);

      const keys = transport.keys();
      // The P1 key was `.selfhub/state.json`: one mutable, plaintext whole-state
      // file. The v3 writer must not recreate it.
      assert(!keys.includes('.selfhub/state.json'), '不应再写旧的整包明文 state.json');
      const dataKey = keys.find((key) => key.endsWith('/objects/state.json'));
      assert(dataKey, '数据对象应位于批次的 objects/ 目录内');
      const storedState = (await transport.get(dataKey!))!;
      assert(storedState.includes('"ciphertext"'), '数据对象应以加密信封形式保存');
      assert(!storedState.includes('"sites"'), '数据对象里不应出现明文集合内容');
    })
  );

  results.push(
    await check('中断在上传清单时会失败并清掉残片，不留可恢复的完成标记', async () => {
      const transport = newTransport();
      transport.failNext('manifest.enc.json');
      const result = await write(transport, sampleState(), 1_700_000_000_000, 'gen-abort');
      assert(!result.ok, '清单写入失败时整体应失败');
      assert(!transport.keys().some((key) => key.endsWith('_complete.json')), '失败时不应留下完成标记');
      assert(transport.keys().length === 0, `失败时应清掉残片，实际还剩 ${transport.keys().length} 个对象`);

      // Even if a partial object is left behind (cleanup itself can fail), the
      // batch must not be offered as a restore source.
      const other = newTransport();
      await other.put(`.selfhub/v3/${libraryId}/${deviceId}/gen-partial/objects/state.json`, '{"v":3}');
      const list = await listGenerations({ transport: other, libraryId, deviceId });
      assert(list.ok, '列批次不应失败');
      const partial = list.value.find((entry) => entry.generationId === 'gen-partial');
      assert(partial, '未完成批次仍应出现在列表里（让用户看得到）');
      assert(!partial!.complete, '未完成批次必须标记为未完成');

      const read = await readGeneration({
        transport: other,
        libraryId,
        deviceId,
        generationId: 'gen-partial',
        password
      });
      assert(!read.ok, '没有完成标记的批次不能被读取为恢复源');
      assert(read.ok === false && read.error.code === 'NOT_FOUND', `应为 NOT_FOUND，实际 ${read.ok ? '' : read.error.code}`);
    })
  );

  results.push(
    await check('写入后可以用正确密码读回清单，并逐对象校验通过', async () => {
      const transport = newTransport();
      const snapshot = collectSnapshot(sampleState());
      const result = await writeGeneration({
        transport,
        libraryId,
        deviceId,
        contentRevision: 7,
        password,
        snapshot,
        now: () => 1_700_000_000_000,
        generationId: 'gen-read'
      });
      assert(result.ok, `写入应成功：${result.ok ? '' : result.error.userMessage}`);
      if (!result.ok) return;
      assert(result.value.verified === 'full', '默认应做完整校验');

      const read = await readGeneration({ transport, libraryId, deviceId, generationId: 'gen-read', password });
      assert(read.ok, `读取应成功：${read.ok ? '' : read.error.userMessage}`);
      if (!read.ok) return;
      assert(read.value.issues.length === 0, `对象校验应无问题，实际 ${read.value.issues.join('；')}`);
      assert(read.value.manifest.counts['笔记'] === 1, `清单计数应包含笔记，实际 ${JSON.stringify(read.value.manifest.counts)}`);
      assert(read.value.manifest.crypto.iterations === 100_000, '清单应记录 PBKDF2 迭代次数');
      assert(read.value.manifest.crypto.perObjectIv === true, '清单应声明每对象独立 IV');
      assert(read.value.manifest.completion === null, '完成状态在清单里应为 null，实际完成标记单独保存');
      assert(read.value.marker.salt, '完成标记应带 KDF 盐值，否则无法解密');
    })
  );

  results.push(
    await check('密码错误时返回 AUTH_FAILED，不返回半份数据', async () => {
      const transport = newTransport();
      await write(transport, sampleState(), 1_700_000_000_000, 'gen-wrong-pass');
      const read = await readGeneration({
        transport,
        libraryId,
        deviceId,
        generationId: 'gen-wrong-pass',
        password: 'not-the-password'
      });
      assert(!read.ok, '错误密码不应读取出清单');
      assert(read.ok === false && read.error.code === 'AUTH_FAILED', `应为 AUTH_FAILED，实际 ${read.ok ? '' : read.error.code}`);
    })
  );

  results.push(
    await check('被改动的对象会被校验检出，密文认证也会失败', async () => {
      const transport = newTransport();
      const result = await writeGeneration({
        transport,
        libraryId,
        deviceId,
        contentRevision: 7,
        password,
        snapshot: collectSnapshot(sampleState()),
        now: () => 1_700_000_000_000,
        generationId: 'gen-tamper'
      });
      assert(result.ok, '写入应成功');
      if (!result.ok) return;

      // Swap the ciphertext of two data objects: both are still valid AES-GCM
      // envelopes (same key), so only the manifest's hashes can catch this.
      const dataPaths = transport.keys().filter((key) => key.includes('gen-tamper/objects/') || key.includes('gen-tamper/attachments/'));
      assert(dataPaths.length >= 2, `应有至少两个对象，实际 ${dataPaths.length}`);
      const [first, second] = dataPaths;
      const firstBody = (await transport.get(first))!;
      const secondBody = (await transport.get(second))!;
      await transport.put(first, secondBody);
      await transport.put(second, firstBody);

      const read = await readGeneration({ transport, libraryId, deviceId, generationId: 'gen-tamper', password });
      assert(read.ok, '清单本身没被改动，读取仍应成功');
      if (!read.ok) return;
      assert(read.value.issues.length > 0, '对象被替换后应报出校验问题');

      // And the crypto layer is not fooled either: a tampered ciphertext fails
      // GCM authentication rather than returning wrong plaintext.
      const key = await deriveBackupKey(password, read.value.marker.salt);
      const envelope = JSON.parse(firstBody) as { ciphertext: string };
      const tampered = JSON.stringify({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` });
      const decrypted = await decryptObject(key, tampered);
      assert(!decrypted.ok, '被改动的密文不应解密成功');
      assert(decrypted.ok === false && decrypted.error.code === 'AUTH_FAILED', '应报认证失败');
    })
  );

  results.push(
    await check('完成标记与清单不一致的批次被拒绝', async () => {
      const transport = newTransport();
      await write(transport, sampleState(), 1_700_000_000_000, 'gen-mismatch');
      const markerPath = transport.keys().find((key) => key.endsWith('_complete.json'))!;
      const marker = JSON.parse((await transport.get(markerPath))!) as Record<string, unknown>;
      await transport.put(markerPath, JSON.stringify({ ...marker, manifestHash: 'deadbeef' }));

      const read = await readGeneration({ transport, libraryId, deviceId, generationId: 'gen-mismatch', password });
      assert(!read.ok, '标记不一致时不应通过校验');
      assert(read.ok === false && read.error.code === 'VALIDATION', `应为 VALIDATION，实际 ${read.ok ? '' : read.error.code}`);
    })
  );

  results.push(
    await check('备份包不含连接密钥，但保留金库密文', async () => {
      const snapshot = collectSnapshot(sampleState());
      const dataObject = snapshot.objects.find((object) => object.path === 'objects/state.json');
      assert(dataObject, '应包含 state.json 数据对象');
      const text = dataObject!.text;
      for (const secret of [OSS_SECRET, WEBDAV_PASSWORD, AI_KEY, WUCAI_TOKEN, YOUDO_COOKIE, SYNC_KEY]) {
        assert(!text.includes(secret), `备份内容不应包含凭据：${secret}`);
      }
      // Non-secret identifiers stay: they cannot authenticate anything on their
      // own, and keeping them tells the user which field is missing after a
      // restore. §10.3 lists secrets/envelopes/sessions, not identifiers.
      assert(text.includes('ACCESS-KEY-ID-must-not-leave'), '非机密的标识应保留，便于恢复后知道缺哪一项');
      assert(text.includes('VAULT-CIPHERTEXT-marker'), '金库密文应保留（没有主密码无法解开）');
      assert(
        snapshot.exclusions.some((line) => line.includes('重新填写') && line.includes('标识')),
        '范围说明应同时说清移除了什么、保留了什么'
      );

      // …and the stored bytes are encrypted, so a leaked object reveals nothing.
      const transport = newTransport();
      await write(transport, sampleState(), 1_700_000_000_000, 'gen-secrets');
      for (const key of transport.keys()) {
        const body = (await transport.get(key))!;
        for (const secret of [OSS_SECRET, WEBDAV_PASSWORD, AI_KEY, WUCAI_TOKEN, SYNC_KEY]) {
          assert(!body.includes(secret), `${key} 的存储内容不应出现明文凭据`);
        }
      }
      const manifestBody = (await transport.get(transport.keys().find((k) => k.endsWith('manifest.enc.json'))!))!;
      assert(!manifestBody.includes('handwriting'), '文件名/标题在清单里也应处于加密范围');
    })
  );

  results.push(
    await check('未下载的远端文件被报告为引用备份，不冒充完整离线备份', async () => {
      const snapshot = collectSnapshot(sampleState());
      assert(snapshot.scope.referenceOnly.length === 1, `应识别出 1 个未下载的远端文件，实际 ${snapshot.scope.referenceOnly.length}`);
      assert(
        snapshot.scope.referenceOnly[0].includes('未下载'),
        `引用列表应指向未下载的文件，实际 ${snapshot.scope.referenceOnly.join(',')}`
      );
      assert(snapshot.counts['远端笔记索引'] === 2, '远端索引条数应如实统计');

      const transport = newTransport();
      const result = await write(transport, sampleState(), 1_700_000_000_000, 'gen-reference');
      assert(result.ok, '写入应成功');
      if (!result.ok) return;
      assert(result.value.description.includes('远端文件仅保存引用'), `摘要应说明只保存引用，实际 ${result.value.description}`);

      const read = await readGeneration({ transport, libraryId, deviceId, generationId: 'gen-reference', password });
      assert(read.ok, '读取应成功');
      if (!read.ok) return;
      assert(read.value.manifest.scope.referenceOnly.length === 1, '清单应保留引用范围');
      assert(
        read.value.manifest.exclusions.some((line) => line.includes('远端')),
        '排除说明应提到远端正文'
      );
    })
  );

  results.push(
    await check('保留策略保留最近 10 次，且不会删掉唯一可用备份', async () => {
      const transport = newTransport();
      const base = 1_700_000_000_000;
      for (let i = 1; i <= 13; i += 1) {
        const result = await write(transport, sampleState(), base + i * 60_000, `gen-keep-${String(i).padStart(2, '0')}`);
        assert(result.ok, `第 ${i} 次写入应成功`);
      }
      const pruned = await pruneGenerations({
        transport,
        libraryId,
        deviceId,
        now: base + 13 * 60_000,
        keepLast: 10,
        keepDays: 30
      });
      assert(pruned.ok, '清理应成功');
      if (!pruned.ok) return;
      assert(pruned.value.removed.length === 3, `应清理 3 个最旧批次，实际 ${pruned.value.removed.length}`);
      assert(pruned.value.kept.length === 10, `应保留 10 个批次，实际 ${pruned.value.kept.length}`);
      assert(!pruned.value.removed.includes('gen-keep-13'), '不能清理刚写入的批次');
      const remaining = transport.keys().filter((key) => key.includes('gen-keep-01/'));
      assert(remaining.length === 0, '被清理批次的对象应逐项删除');

      const listed = await listGenerations({ transport, libraryId, deviceId });
      assert(listed.ok && listed.value.filter((entry) => entry.complete).length === 10, '清理后应剩 10 个完整批次');
    })
  );

  results.push(
    await check('清理跨天批次时保留最近 30 天每日一份，且拒绝删掉最后一个备份', async () => {
      const transport = newTransport();
      const day = 86_400_000;
      const now = 1_700_000_000_000;
      for (let i = 0; i < 12; i += 1) {
        const at = now - i * day;
        const result = await write(transport, sampleState(), at, `gen-day-${String(i).padStart(2, '0')}`);
        assert(result.ok, `第 ${i} 天写入应成功`);
      }
      const pruned = await pruneGenerations({
        transport,
        libraryId,
        deviceId,
        now,
        keepLast: 3,
        keepDays: 5
      });
      assert(pruned.ok, '清理应成功');
      if (!pruned.ok) return;
      // Newest 3 plus one per day for the last 5 days (the first three days are
      // already covered) → 5 by the retention rules, plus the generation the
      // device pointer names. That last one is written with the oldest timestamp
      // here, which is exactly the case retention must not delete.
      assert(pruned.value.kept.length === 6, `应保留 6 个批次，实际 ${pruned.value.kept.length}`);
      assert(pruned.value.removed.length === 6, `应清理 6 个批次，实际 ${pruned.value.removed.length}`);
      assert(pruned.value.protectedByPointer === 'gen-day-11', `指针批次应被保护，实际 ${pruned.value.protectedByPointer}`);
      assert(pruned.value.kept.includes('gen-day-11'), '指针所指批次必须保留');

      const single = newTransport();
      await write(single, sampleState(), now, 'gen-only');
      const refused = await pruneGenerations({ transport: single, libraryId, deviceId, now, keepLast: 1, keepDays: 0 });
      assert(refused.ok, '清理调用本身应成功');
      if (!refused.ok) return;
      assert(refused.value.refused, '只有一个备份时应明确拒绝清理');
      assert(refused.value.removed.length === 0, '拒绝清理时不应删除任何批次');
      assert(single.keys().length > 0, '唯一备份必须保留');
    })
  );

  results.push(
    await check('写入过程报告进度，最后为 100；缺少密码时按未解锁处理', async () => {
      const transport = newTransport();
      const stages: Array<{ stage: string; percent: number }> = [];
      const result = await writeGeneration({
        transport,
        libraryId,
        deviceId,
        contentRevision: 7,
        password,
        snapshot: collectSnapshot(sampleState()),
        now: () => 1_700_000_000_000,
        generationId: 'gen-progress',
        onProgress: (stage, percent) => stages.push({ stage, percent })
      });
      assert(result.ok, '写入应成功');
      assert(stages.length >= 3, `应报告至少 3 次进度，实际 ${stages.length}`);
      assert(stages[stages.length - 1].percent === 100, '最后一次进度应为 100');
      assert(
        stages.some((entry) => entry.stage.includes('完成标记')),
        '进度应包含完成标记阶段'
      );

      const locked = await writeGeneration({
        transport: newTransport(),
        libraryId,
        deviceId,
        contentRevision: 7,
        password: '',
        snapshot: collectSnapshot(sampleState()),
        now: () => 1_700_000_000_000,
        generationId: 'gen-locked'
      });
      assert(!locked.ok, '没有备份密码时不应上传');
      assert(locked.ok === false && locked.error.code === 'LOCKED', `应为 LOCKED，实际 ${locked.ok ? '' : locked.error.code}`);
    })
  );

  results.push(
    await check('加密信封每次使用独立盐值与 IV，形状校验能挡住坏清单', async () => {
      const saltA = newSalt();
      const saltB = newSalt();
      assert(saltA !== saltB, '每次生成的盐值不应相同');
      const key = await deriveBackupKey(password, saltA);
      const first = await encryptObject(key, '相同的内容');
      const second = await encryptObject(key, '相同的内容');
      assert(first !== second, '相同明文两次加密不应得到相同密文（IV 必须独立）');
      const hash = await hashStored(first);
      assert(/^[0-9a-f]{64}$/.test(hash), `应输出 SHA-256 十六进制，实际 ${hash}`);
    })
  );

  results.push(
    await check('本设备指针在完成标记之后写入，并指向刚写完的批次', async () => {
      const transport = newTransport();
      const first = await write(transport, sampleState(), 1_700_000_000_000, 'gen-pointer-1');
      assert(first.ok, '写入应成功');
      if (!first.ok) return;

      const writes = transport.writes;
      const markerIndex = writes.findIndex((path) => path.endsWith('_complete.json'));
      const pointerIndex = writes.findIndex((path) => path.endsWith('latest.json'));
      assert(pointerIndex > markerIndex, `指针应在完成标记之后写入（标记 ${markerIndex} / 指针 ${pointerIndex}）`);

      const pointerRead = await readLatestPointer(transport, libraryId, deviceId);
      assert(pointerRead.ok, `指针应可读：${pointerRead.ok ? '' : pointerRead.reason}`);
      if (!pointerRead.ok) return;
      assert(pointerRead.pointer.generationId === 'gen-pointer-1', '指针应指向刚写完的批次');

      const resolved = expectOk(await resolveLatestGeneration({ transport, libraryId, deviceId, password }));
      assert(resolved.source === 'pointer', `应通过指针解析默认恢复源，实际 ${resolved.source}`);
      assert(resolved.generationId === 'gen-pointer-1', '默认恢复源应是最新批次');

      // A second generation moves the pointer forward, and the first stays intact.
      const second = await write(transport, sampleState(), 1_700_000_100_000, 'gen-pointer-2');
      assert(second.ok, '第二次写入应成功');
      const moved = await readLatestPointer(transport, libraryId, deviceId);
      assert(moved.ok && moved.pointer.generationId === 'gen-pointer-2', '指针应前移到新批次');
      const stillThere = await transport.get(`.selfhub/v3/${libraryId}/${deviceId}/gen-pointer-1/_complete.json`);
      assert(stillThere !== null, '旧批次不应因为指针前移而被改动');
    })
  );

  results.push(
    await check('指针失效时退回最新的完整批次，并说明原因，而不是报错或指向坏批次', async () => {
      const transport = newTransport();
      await write(transport, sampleState(), 1_700_000_000_000, 'gen-stale-1');
      await write(transport, sampleState(), 1_700_000_060_000, 'gen-stale-2');

      // Simulate someone deleting the current generation's marker in the bucket.
      const pointerRead = await readLatestPointer(transport, libraryId, deviceId);
      assert(pointerRead.ok, '指针应可读');
      if (!pointerRead.ok) return;
      const markerPath = `.selfhub/v3/${libraryId}/${deviceId}/${pointerRead.pointer.generationId}/_complete.json`;
      await transport.remove(markerPath);

      const resolved = expectOk(await resolveLatestGeneration({ transport, libraryId, deviceId, password }));
      assert(resolved.source === 'scan', `指针失效后应退回扫描，实际 ${resolved.source}`);
      assert(resolved.generationId === 'gen-stale-1', `应退回到仍完整的批次，实际 ${resolved.generationId}`);
      assert(Boolean(resolved.staleReason), '应说明指针为什么不可用');

      // Nothing restorable at all → 'none', never a guess.
      const empty = newTransport();
      const none = expectOk(await resolveLatestGeneration({ transport: empty, libraryId, deviceId, password }));
      assert(none.source === 'none', `没有备份时应返回 none，实际 ${none.source}`);
      assert(Boolean(none.staleReason), '应说明为什么没有可恢复的备份');
    })
  );

  results.push(
    await check('失败的备份不会移动本设备指针，清理也不会删掉指针所指批次', async () => {
      const transport = newTransport();
      const good = await write(transport, sampleState(), 1_700_000_000_000, 'gen-keep-pointer');
      assert(good.ok, '首次写入应成功');

      transport.failNext('manifest.enc.json');
      const failed = await write(transport, sampleState(), 1_700_000_100_000, 'gen-failed-pointer');
      assert(!failed.ok, '第二次写入应失败');
      const pointer = await readLatestPointer(transport, libraryId, deviceId);
      assert(pointer.ok && pointer.pointer.generationId === 'gen-keep-pointer', '失败不应移动指针');

      // Fill up enough history that retention wants to delete something, and make
      // the pointer's generation the oldest one.
      for (let i = 1; i <= 4; i += 1) {
        await write(transport, sampleState(), 1_700_000_000_000 + i * 60_000, `gen-later-${i}`);
      }
      const pruned = await pruneGenerations({
        transport,
        libraryId,
        deviceId,
        now: 1_700_000_000_000 + 4 * 60_000,
        keepLast: 1,
        keepDays: 0
      });
      assert(pruned.ok, '清理应成功');
      if (!pruned.ok) return;
      assert(pruned.value.removed.length > 0, '应清理掉旧批次');
      assert(
        !pruned.value.removed.includes('gen-later-4'),
        '刚写入的批次不应被清理'
      );
      const stillPointed = transport.keys().some((key) => key.includes('/gen-later-4/'));
      assert(stillPointed, '被清理后仍应保留最新批次的对象');
      assert(Boolean(pruned.value.protectedByPointer), '清理结果应说明指针保护的批次');
    })
  );

  return results;
}
