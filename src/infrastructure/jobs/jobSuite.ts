/**
 * Durable job queue self-check suite (P2-05).
 * Runs **in a real browser** through the dev-only bridge, like the repository
 * contract suite, because the guarantees here are about IndexedDB transactions
 */
import { appError } from '../../repositories/errors';
import { IndexedDbRepository } from '../../repositories/indexedDbRepository';
import { JobQueue, RETRY_BACKOFF_MS, type JobRecord } from './jobQueue';
import { JobRunner, describeJob, outcomeFromError } from './jobRunner';

export interface JobCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

function fakeClock(start: number): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    }
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; userMessage: string } }): T {
  assert(result.ok, `期望成功，实际失败: ${result.ok ? '' : `${result.error.code} ${result.error.userMessage}`}`);
  return result.value;
}

async function check(name: string, run: () => Promise<void>): Promise<JobCheckResult> {
  try {
    await run();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export interface JobSuiteOptions {
  /** Prefix for library ids so repeated runs never collide. */
  runId: string;
}

export async function runJobSuite(options: JobSuiteOptions): Promise<JobCheckResult[]> {
  const runId = options.runId;
  /** One isolated library per check; see the note at the top of this file. */
  const lib = (name: string) => `jobs-${runId}-${name}`;
  const base = 1_700_000_000_000;
  const results: JobCheckResult[] = [];

  /** Read a job, failing the check rather than returning undefined. */
  const readJob = async (queue: JobQueue, id: string): Promise<JobRecord> => {
    const read = await queue.get(id);
    const job = read.ok ? read.value : undefined;
    assert(job, `任务 ${id} 应存在`);
    return job!;
  };

  results.push(
    await check('同一 scopeKey 只排队一条，重复入队返回原任务', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('dedupe'), now: clock.now });
      const first = expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-a` }));
      assert(first.created, '首次入队应标记为新建');
      const second = expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-a` }));
      assert(!second.created, '重复入队不应再建一条');
      assert(second.job.id === first.job.id, '重复入队应返回同一条任务');
      const all = expectOk(await queue.list({ scopeKey: `${runId}-scope-a` }));
      assert(all.length === 1, `同一 scopeKey 只应有一条，实际 ${all.length}`);
    })
  );

  results.push(
    await check('认领会写入租约，同一时刻第二个执行者拿不到同一条', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('lease'), now: clock.now });
      const job = expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-b` })).job;
      const claimed = expectOk(await queue.claimNext({ owner: 'worker-a', now: clock.now() }));
      assert(claimed?.id === job.id, '第一个执行者应领到该任务');
      assert(claimed!.lease?.owner === 'worker-a', '认领后应带本执行者的租约');
      const second = expectOk(await queue.claimNext({ owner: 'worker-b', now: clock.now() }));
      assert(second === null, `租约有效期间第二个执行者不应领到任务，实际领到 ${second?.id}`);
    })
  );

  results.push(
    await check('执行者失联后租约过期可被回收，任务不会永远卡在 running', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('reclaim'), now: clock.now });
      const job = expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-c` })).job;
      expectOk(await queue.claimNext({ owner: 'worker-a', now: clock.now(), leaseMs: 60_000 }));

      const tooEarly = expectOk(await queue.claimNext({ owner: 'worker-b', now: clock.now() }));
      assert(tooEarly === null, '租约未过期时不应被抢走');

      clock.advance(60_001);
      const recovered = expectOk(await queue.requeueExpired(clock.now()));
      assert(recovered.length === 1 && recovered[0].id === job.id, '过期租约应被回收并回到排队');

      const claimed = expectOk(await queue.claimNext({ owner: 'worker-b', now: clock.now() }));
      assert(claimed?.id === job.id, '回收后新的执行者应能领到同一条任务');
      assert(claimed!.attempt === 2, `回收后的认领应计入下一次尝试，实际 attempt=${claimed!.attempt}`);
    })
  );

  results.push(
    await check('可重试失败按 30 秒、2 分钟、10 分钟退避，共 3 次自动重试', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('retry'), now: clock.now });
      const runner = new JobRunner({ queue, owner: 'worker-r', now: clock.now, heartbeat: false });
      runner.register('flaky', async () => {
        throw appError('NETWORK_UNREACHABLE', '目标当前无法访问。');
      });

      const job = expectOk(await queue.enqueue({ kind: 'flaky', scopeKey: `${runId}-scope-retry` })).job;
      const observed: number[] = [];

      for (let round = 0; round < RETRY_BACKOFF_MS.length; round += 1) {
        const summary = await runner.runDue();
        assert(summary.claimed === 1, `第 ${round + 1} 次执行应领到任务，实际 ${summary.claimed}`);
        const after = await readJob(queue, job.id);
        assert(after.state === 'queued', `第 ${round + 1} 次失败后应重新排队，实际 ${after.state}`);
        const delay = (after.nextRunAt ?? 0) - clock.now();
        observed.push(delay);
        clock.advance(delay);
      }

      const finalRun = await runner.runDue();
      assert(finalRun.claimed === 1, `最后一次尝试应被执行，实际领到 ${finalRun.claimed}`);
      const finished = await readJob(queue, job.id);
      assert(finished.state === 'failed', `用尽重试后应停止自动重试，实际 ${finished.state}`);
      assert(finished.attempt === 1 + RETRY_BACKOFF_MS.length, `总尝试次数应为 4，实际 ${finished.attempt}`);
      assert(
        JSON.stringify(observed) === JSON.stringify(RETRY_BACKOFF_MS),
        `退避序列应为 ${RETRY_BACKOFF_MS.join('/')}，实际 ${observed.join('/')}`
      );

      clock.advance(24 * 60 * 60 * 1000);
      const later = await runner.runDue();
      assert(later.claimed === 0, '停止重试后不应再被唤醒执行');
    })
  );

  results.push(
    await check('认证失败不会被自动重试，直接停下来等用户处理', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('auth'), now: clock.now });
      const runner = new JobRunner({ queue, owner: 'worker-auth', now: clock.now, heartbeat: false });
      runner.register('auth-fail', async () => {
        throw appError('AUTH_FAILED', '密钥被拒绝，请更新连接密钥。');
      });
      const job = expectOk(await queue.enqueue({ kind: 'auth-fail', scopeKey: `${runId}-scope-auth` })).job;
      await runner.runDue();

      const after = await readJob(queue, job.id);
      assert(after.state === 'failed', `认证失败应为失败终态，实际 ${after.state}`);
      assert(after.attempt === 1, `认证失败不应消耗重试，实际 attempt=${after.attempt}`);
      assert((after.blockedReason ?? '').includes('密钥'), `应保留可读原因，实际 ${after.blockedReason ?? '(空)'}`);

      clock.advance(60 * 60 * 1000);
      const later = await runner.runDue();
      assert(later.claimed === 0, '认证失败后不应被自动唤醒');
    })
  );

  results.push(
    await check('金库锁定时进入 waiting-unlock，解锁后可继续，而不是报失败或成功', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('lock'), now: clock.now });
      let unlocked = false;
      const runner = new JobRunner({ queue, owner: 'worker-lock', now: clock.now, heartbeat: false });
      runner.register('encrypted-upload', async () => {
        if (!unlocked) throw appError('LOCKED', '需要先解锁金库才能加密备份。');
        return { type: 'success', message: '已完成' };
      });

      const job = expectOk(await queue.enqueue({ kind: 'encrypted-upload', scopeKey: `${runId}-scope-lock` })).job;
      await runner.runDue();

      const parked = await readJob(queue, job.id);
      assert(parked.state === 'waiting-unlock', `锁定时应停在 waiting-unlock，实际 ${parked.state}`);
      assert(!parked.result, '等待解锁不是成功，不应写入成功结果');

      clock.advance(60 * 60 * 1000);
      const notRunnable = expectOk(await queue.claimNext({ owner: 'worker-probe', now: clock.now() }));
      assert(notRunnable === null, '等待解锁的任务不应被自动唤醒执行');

      unlocked = true;
      const resumed = expectOk(await queue.resumeWaitingUnlock({ scopeKey: `${runId}-scope-lock` }));
      assert(resumed.length === 1, `解锁后应恢复 1 条任务，实际 ${resumed.length}`);
      const summary = await runner.runDue();
      assert(summary.claimed === 1, '解锁后应能继续执行');
      const done = await readJob(queue, job.id);
      assert(done.state === 'succeeded', `解锁后应成功，实际 ${done.state}`);
    })
  );

  results.push(
    await check('排队的任务可直接取消，不会被再执行', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('cancel-queued'), now: clock.now });
      const job = expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-cancel-q` })).job;
      const cancelled = expectOk(await queue.requestCancel(job.id, '用户取消'));
      assert(cancelled?.state === 'cancelled', `排队中的任务应直接取消，实际 ${cancelled?.state}`);

      const runner = new JobRunner({ queue, owner: 'worker-cancel', now: clock.now, heartbeat: false });
      runner.register('backup', async () => ({ type: 'success' }));
      clock.advance(60 * 60 * 1000);
      const summary = await runner.runDue();
      assert(summary.claimed === 0, '已取消的任务不应再被领走');
    })
  );

  results.push(
    await check('执行中的任务能观察到取消请求并正常收尾', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('cancel-running'), now: clock.now });
      const runner = new JobRunner({ queue, owner: 'worker-cancel-run', now: clock.now, heartbeat: false });
      let sawCancel = false;
      runner.register('long-upload', async (ctx) => {
        for (let i = 0; i < 400; i += 1) {
          if (await ctx.isCancelRequested()) {
            sawCancel = true;
            break;
          }
          await tick();
        }
        return { type: 'success', message: '不该成功' };
      });

      const job = expectOk(await queue.enqueue({ kind: 'long-upload', scopeKey: `${runId}-scope-cancel-run` })).job;
      const running = runner.runDue();

      // Wait until the job is genuinely claimed before cancelling: cancelling a
      // still-queued job is a different (also tested) path.
      let claimed = false;
      for (let i = 0; i < 100; i += 1) {
        const current = await queue.get(job.id);
        if (current.ok && current.value?.state === 'running') {
          claimed = true;
          break;
        }
        await tick();
      }
      assert(claimed, '任务应已进入执行中');

      await queue.requestCancel(job.id, '用户取消');
      await running;

      const after = await readJob(queue, job.id);
      assert(sawCancel, '执行者应能看到取消请求');
      assert(after.state === 'cancelled', `执行中被取消后应为 cancelled，实际 ${after.state}`);
    })
  );

  results.push(
    await check('执行者失联时取消请求仍然生效，不会被静默当成成功', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('cancel-dead'), now: clock.now });
      const job = expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-cancel-dead` })).job;
      expectOk(await queue.claimNext({ owner: 'worker-dead', now: clock.now(), leaseMs: 60_000 }));
      expectOk(await queue.requestCancel(job.id, '用户取消'));

      clock.advance(60_001);
      expectOk(await queue.requeueExpired(clock.now()));

      const runner = new JobRunner({ queue, owner: 'worker-next', now: clock.now, heartbeat: false });
      let ran = false;
      runner.register('backup', async () => {
        ran = true;
        return { type: 'success' };
      });
      await runner.runDue();

      const after = await readJob(queue, job.id);
      assert(!ran, '带取消标记的任务不应再进入执行体');
      assert(after.state === 'cancelled', `应保持取消状态，实际 ${after.state}`);
    })
  );

  results.push(
    await check('进度被夹在 0–100，且不改变任务状态', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('progress'), now: clock.now });
      const job = expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-progress` })).job;
      expectOk(await queue.claimNext({ owner: 'worker-p', now: clock.now() }));
      expectOk(await queue.reportProgress(job.id, 150));
      assert((await readJob(queue, job.id)).progress === 100, '超过 100 的进度应被夹到 100');
      expectOk(await queue.reportProgress(job.id, -5));
      const low = await readJob(queue, job.id);
      assert(low.progress === 0, '负进度应被夹到 0');
      assert(low.state === 'running', `汇报进度不应改变状态，实际 ${low.state}`);
    })
  );

  results.push(
    await check('日志与阻断原因经过脱敏，不留下凭据', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('log'), now: clock.now });
      const runner = new JobRunner({ queue, owner: 'worker-log', now: clock.now, heartbeat: false });
      const password = 'hunter2verysecret';
      const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz012345';
      runner.register('leaky', async () => ({
        type: 'blocked',
        message: `服务商返回：password: ${password} 且 api_key: ${apiKey}`
      }));

      const job = expectOk(await queue.enqueue({ kind: 'leaky', scopeKey: `${runId}-scope-log` })).job;
      await runner.runDue();

      const after = await readJob(queue, job.id);
      const dump = JSON.stringify(after);
      assert(!dump.includes(password), '日志里不应出现密码明文');
      assert(!dump.includes(apiKey), '日志里不应出现 API Key 明文');
      assert(dump.includes('SH_MASKED'), '应留下可读的遮蔽标记，便于知道确实脱敏过');
      assert(Boolean(after.blockedReason) && !after.blockedReason!.includes(password), '阻断原因同样要脱敏');
    })
  );

  results.push(
    await check('更新任务状态不会改变内容版本（不会触发备份无限循环）', async () => {
      const clock = fakeClock(base);
      const repo = new IndexedDbRepository({ libraryId: `jobs-rev-${runId}` });
      try {
        expectOk(await repo.init());
        const events: number[] = [];
        const unsubscribe = repo.subscribe((event) => events.push(event.contentRevision));
        const before = expectOk(await repo.getContentRevision());

        const queue = new JobQueue({ libraryId: lib('revision'), now: clock.now });
        const runner = new JobRunner({ queue, owner: 'worker-rev', now: clock.now, heartbeat: false });
        runner.register('backup', async (ctx) => {
          await ctx.reportProgress(50);
          return { type: 'success', message: '完成' };
        });
        for (let i = 0; i < 3; i += 1) {
          expectOk(await queue.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-rev-${i}` }));
          await runner.runDue();
        }
        const summary = expectOk(await queue.summary());
        assert(summary.succeeded >= 3, `应有 3 条成功任务，实际 ${summary.succeeded}`);

        const after = expectOk(await repo.getContentRevision());
        unsubscribe();
        assert(after === before, `任务状态变化不应改变内容版本：${before} → ${after}`);
        assert(events.length === 0, `任务状态变化不应广播内容变更事件，实际收到 ${events.length} 次`);
      } finally {
        repo.close();
      }
    })
  );

  results.push(
    await check('没有注册执行器的任务会被明确阻断，而不是静默丢弃', async () => {
      const clock = fakeClock(base);
      const queue = new JobQueue({ libraryId: lib('unknown-kind'), now: clock.now });
      const runner = new JobRunner({ queue, owner: 'worker-empty', now: clock.now, heartbeat: false });
      const job = expectOk(await queue.enqueue({ kind: 'no-such-kind', scopeKey: `${runId}-scope-unknown` })).job;
      await runner.runDue();

      const after = await readJob(queue, job.id);
      assert(after.state === 'failed', `未知任务类型应停下，实际 ${after.state}`);
      assert(
        (after.blockedReason ?? '').includes('执行器'),
        `应说明缺少执行器，实际 ${after.blockedReason ?? '(空)'}`
      );
    })
  );

  results.push(
    await check('重新构造队列对象后仍能领到排队任务（不依赖内存状态）', async () => {
      const clock = fakeClock(base);
      const writer = new JobQueue({ libraryId: lib('restart'), now: clock.now });
      const job = expectOk(await writer.enqueue({ kind: 'backup', scopeKey: `${runId}-scope-restart` })).job;

      // A brand-new instance with no shared memory: this is what a page reload or
      // a restarted MV3 worker looks like.
      const afterRestart = base + 1_000;
      const reader = new JobQueue({ libraryId: lib('restart'), now: () => afterRestart });
      const claimed = expectOk(await reader.claimNext({ owner: 'worker-after-restart', now: afterRestart }));
      assert(claimed?.id === job.id, '重启后应能重新认领排队中的任务');
    })
  );

  results.push(
    await check('状态文案与错误映射覆盖主要分支', async () => {
      assert(describeJob({ state: 'waiting-unlock', attempt: 1 }) === '等待解锁', 'waiting-unlock 文案不匹配');
      assert(describeJob({ state: 'failed', attempt: 3 }) === '失败（已尝试 3 次）', 'failed 文案不匹配');
      assert(outcomeFromError(appError('LOCKED', '锁定')).type === 'waiting-unlock', 'LOCKED 应映射为等待解锁');
      assert(outcomeFromError(appError('AUTH_FAILED', '密钥')).type === 'blocked', 'AUTH_FAILED 应映射为阻断');
      assert(outcomeFromError(appError('NETWORK_UNREACHABLE', '断网')).type === 'retry', '网络失败应映射为重试');
      const unknown = outcomeFromError(new Error('未知错误'));
      assert(unknown.type === 'blocked', `未识别的错误不应默认重试，实际 ${unknown.type}`);
    })
  );

  return results;
}
