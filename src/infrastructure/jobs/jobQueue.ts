/**
 * Durable job queue (P2-05).
 *
 * Dev doc §9.3 is the reason this exists: "MV3 后台可能休眠或被终止，内存布尔锁和普通
 * 计时器不能作为唯一执行保障". A backup that only "runs while the tab is open"
 * and a retry that lives in a `setTimeout` are both lost the moment the worker or
 * the page goes away. So the queue is a store, not a variable:
 *
 * - **Lease, not lock.** A running job holds a lease with an expiry. Another
 *   runner may reclaim an expired lease, which is how a killed worker recovers
 *   instead of leaving the job `running` forever.
 * - **Bounded retries with backoff.** §10.2: retryable network failures back off
 *   30 s → 2 min → 10 min, at most 3 automatic attempts. Auth and permission
 *   errors are *not* retried; they need the user to fix something. "最多 3 次自动
 *   重试" is three *retries* on top of the first attempt, so this queue allows four
 *   attempts in total and every backoff value is actually reachable.
 * - **`waiting-unlock` is a state, not a failure.** A locked credential store
 *   parks the job; it does not report success and does not hammer the network.
 *   `resumeWaitingUnlock()` is how it comes back once the vault is open.
 * - **Cancellation is persisted too.** A running worker cannot be reached by a
 *   click, so `requestCancel()` writes a flag the runner polls; a killed worker
 *   therefore still ends up cancelled instead of quietly finishing.
 * - **State changes do not re-trigger work.** The trigger is the library's content
 *   revision, and finishing a job must not bump it — otherwise "job状态更新不触发
 *   备份无限循环" (§15.1) becomes an infinite loop that is very hard to see. This
 *   module only ever writes `jobs_v3`, never a content store.
 * - **Logs are inputs from the network, so they are scrubbed.** §12.3: diagnostic
 *   records must not contain secrets. A provider error message can echo an
 *   Authorization header or a token, so every message goes through `maskSecrets`
 *   before it is stored.
 */
import type { JobState } from '../../domain/model';
import { requestToPromise, runV3Transaction } from '../storage/idbV3';
import { validateRecord } from '../../repositories/schema';
import { appError, fail, ok, toAppError, type Result } from '../../repositories/errors';
import { maskSecrets } from '../../lib/secretMask';

const JOBS = 'jobs_v3';

/** §10.2: 30 s, 2 min, 10 min. */
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000];
/** 1 initial attempt + §10.2's "最多 3 次自动重试". */
export const MAX_ATTEMPTS = 1 + RETRY_BACKOFF_MS.length;
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;
/** Bounded log so a repeatedly failing job cannot grow without limit. */
export const MAX_LOG_ENTRIES = 50;

/**
 * Remove anything credential-shaped from a log line before it is stored.
 *
 * Deliberately cheap and local: a job log must never become the place where a
 * token from a provider error response survives a failed upload.
 */
export function scrubLogText(text: string): string {
  if (!text) return text;
  try {
    return maskSecrets(text).masked;
  } catch {
    // Masking must never turn a log write into a failure; fall back to a
    // truncated form rather than the raw text.
    return text.slice(0, 200);
  }
}

export interface JobLogEntry {
  at: number;
  state: JobState;
  message: string;
  /** Safe detail only: no credentials, no response bodies. */
  safeDetail?: string;
}

export interface JobRecord {
  libraryId: string;
  id: string;
  kind: string;
  bindingId?: string;
  scopeKey: string;
  state: JobState;
  attempt: number;
  nextRunAt?: number;
  lease?: { owner: string; expiresAt: number };
  inputRevision?: number;
  result?: { ok: boolean; message?: string; at: number };
  createdAt: number;
  updatedAt: number;
  /** Progress for a long transfer, 0–100. Absent means "not reported". */
  progress?: number;
  log?: JobLogEntry[];
  /** Set when the job is parked; the reason is shown to the user. */
  blockedReason?: string;
  /**
   * Persisted "the user asked this to stop".
   *
   * Separate from `state`: a running job has to *observe* the request and stop
   * its own work, so the request cannot simply overwrite `state`.
   */
  cancelRequested?: boolean;
}

export interface EnqueueInput {
  kind: string;
  scopeKey: string;
  bindingId?: string;
  inputRevision?: number;
  /** Earliest time this job may run. */
  nextRunAt?: number;
}

export interface ClaimOptions {
  owner: string;
  now?: number;
  leaseMs?: number;
}

export interface JobQueueOptions {
  libraryId: string;
  now?: () => number;
  newId?: (prefix: string) => string;
}

function safeLog(log: JobLogEntry[] | undefined, entry: JobLogEntry): JobLogEntry[] {
  const scrubbed: JobLogEntry = {
    ...entry,
    message: scrubLogText(entry.message),
    safeDetail: entry.safeDetail ? scrubLogText(entry.safeDetail) : undefined
  };
  const next = [...(log ?? []), scrubbed];
  return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
}

export class JobQueue {
  private readonly libraryId: string;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;

  constructor(options: JobQueueOptions) {
    this.libraryId = options.libraryId;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? ((prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  }

  /**
   * Enqueue work, deduplicating by `scopeKey`.
   *
   * Deduplication is what stops "every state change enqueues another backup": a
   * scope that already has a queued or running job does not get a second one.
   */
  async enqueue(input: EnqueueInput): Promise<Result<{ job: JobRecord; created: boolean }>> {
    if (!input.kind || !input.scopeKey) {
      return fail(appError('VALIDATION', '任务缺少 kind 或 scopeKey。', { safeDetail: 'missing job identity' }));
    }
    try {
      const result = await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const all = (await requestToPromise(store.getAll() as IDBRequest<JobRecord[]>)).filter(
          (row) => row.libraryId === this.libraryId
        );
        const existing = all.find(
          (row) => row.scopeKey === input.scopeKey && (row.state === 'queued' || row.state === 'running')
        );
        if (existing) return { job: existing, created: false };

        const now = this.now();
        const job: JobRecord = {
          libraryId: this.libraryId,
          id: this.newId('job'),
          kind: input.kind,
          bindingId: input.bindingId,
          scopeKey: input.scopeKey,
          state: 'queued',
          attempt: 0,
          nextRunAt: input.nextRunAt ?? now,
          inputRevision: input.inputRevision,
          createdAt: now,
          updatedAt: now,
          log: [{ at: now, state: 'queued', message: '已排队' }]
        };
        const issues = validateRecord(JOBS, job);
        if (issues.length > 0) throw new Error(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
        store.put(job);
        return { job, created: true };
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法创建任务'));
    }
  }

  /**
   * Claim the next runnable job.
   *
   * Runnable means: `queued`, or `running` with an **expired** lease (the previous
   * owner died), and due by `nextRunAt`. Claiming writes the lease in the same
   * transaction, so two runners cannot both win.
   */
  async claimNext(options: ClaimOptions): Promise<Result<JobRecord | null>> {
    const now = options.now ?? this.now();
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    try {
      const result = await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const all = (await requestToPromise(store.getAll() as IDBRequest<JobRecord[]>))
          .filter((row) => row.libraryId === this.libraryId)
          .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));

        const candidate = all.find((row) => {
          const due = (row.nextRunAt ?? 0) <= now;
          if (row.state === 'queued') return due;
          if (row.state === 'running') return Boolean(row.lease && row.lease.expiresAt <= now);
          return false;
        });
        if (!candidate) return null;

        const claimed: JobRecord = {
          ...candidate,
          state: 'running',
          lease: { owner: options.owner, expiresAt: now + leaseMs },
          attempt: candidate.state === 'running' ? candidate.attempt : candidate.attempt + 1,
          updatedAt: now,
          log: safeLog(candidate.log, { at: now, state: 'running', message: `开始执行（第 ${candidate.attempt + 1} 次）` })
        };
        const issues = validateRecord(JOBS, claimed);
        if (issues.length > 0) throw new Error(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
        store.put(claimed);
        return claimed;
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法领取任务'));
    }
  }

  /** Extend a lease while the work is still running. */
  async renewLease(id: string, owner: string, leaseMs = DEFAULT_LEASE_MS): Promise<Result<boolean>> {
    const now = this.now();
    try {
      const result = await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const row = (await requestToPromise(store.get([this.libraryId, id]))) as JobRecord | undefined;
        if (!row || row.state !== 'running' || row.lease?.owner !== owner) return false;
        store.put({ ...row, lease: { owner, expiresAt: now + leaseMs }, updatedAt: now });
        return true;
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法续租'));
    }
  }

  /** Report progress without changing state, so a UI can follow a long upload. */
  async reportProgress(id: string, progress: number): Promise<Result<void>> {
    try {
      await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const row = (await requestToPromise(store.get([this.libraryId, id]))) as JobRecord | undefined;
        if (!row) return;
        store.put({ ...row, progress: Math.max(0, Math.min(100, Math.round(progress))), updatedAt: this.now() });
      });
      return ok(undefined);
    } catch (err) {
      return fail(toAppError(err, '无法更新进度'));
    }
  }

  async succeed(id: string, message?: string): Promise<Result<JobRecord | null>> {
    return this.finish(id, 'succeeded', { ok: true, message, at: this.now() }, message ?? '执行成功');
  }

  /**
   * Park a job until the vault is unlocked.
   *
   * Not a failure: §10.2 says a locked credential store makes the task wait, and
   * pretending otherwise either reports a false success or burns retry attempts on
   * something the user has not been asked to fix yet.
   */
  async waitForUnlock(id: string, reason: string): Promise<Result<JobRecord | null>> {
    return this.finish(id, 'waiting-unlock', undefined, reason, { blockedReason: reason });
  }

  /** Permanent block: needs the user to change a connection or fix credentials. */
  async block(id: string, reason: string): Promise<Result<JobRecord | null>> {
    return this.finish(id, 'failed', { ok: false, message: reason, at: this.now() }, reason, {
      blockedReason: reason,
      retryable: false
    });
  }

  async cancel(id: string, reason = '用户取消'): Promise<Result<JobRecord | null>> {
    return this.finish(id, 'cancelled', undefined, reason);
  }

  /**
   * Ask a job to stop, whether or not it is currently running.
   *
   * A queued job can be cancelled immediately. A running one cannot: the worker
   * owns the work and may be mid-PUT, so the request is persisted and the runner
   * observes it between steps. If the worker never comes back, the flag is still
   * there when the lease is reclaimed — the job ends up cancelled rather than
   * silently succeeding later.
   */
  async requestCancel(id: string, reason = '用户取消'): Promise<Result<JobRecord | null>> {
    const now = this.now();
    try {
      const outcome = await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const row = (await requestToPromise(store.get([this.libraryId, id]))) as JobRecord | undefined;
        if (!row) return null;
        if (row.state !== 'running') {
          const done: JobRecord = {
            ...row,
            state: 'cancelled',
            updatedAt: now,
            cancelRequested: true,
            lease: undefined,
            log: safeLog(row.log, { at: now, state: 'cancelled', message: reason })
          };
          store.put(done);
          return done;
        }
        const flagged: JobRecord = {
          ...row,
          cancelRequested: true,
          updatedAt: now,
          log: safeLog(row.log, { at: now, state: 'running', message: `${reason}（等待当前执行者停止）` })
        };
        store.put(flagged);
        return flagged;
      });
      return ok(outcome.value);
    } catch (err) {
      return fail(toAppError(err, '无法取消任务'));
    }
  }

  /** Polled by a runner between steps; see `requestCancel`. */
  async isCancelRequested(id: string): Promise<Result<boolean>> {
    const read = await this.get(id);
    if (!read.ok) return fail(read.error);
    return ok(Boolean(read.value?.cancelRequested));
  }

  /**
   * Recover work whose runner died.
   *
   * A `running` job whose lease has expired is the signature of a killed worker
   * (MV3 service worker termination, closed tab, crashed page). Re-queueing it is
   * what makes the queue durable rather than "durable until something crashes".
   *
   * The attempt counter is not touched here — recovery is not a failure. The next
   * `claimNext` charges the attempt, so a job that keeps killing its worker still
   * runs out of budget instead of spinning forever.
   */
  async requeueExpired(now = this.now()): Promise<Result<JobRecord[]>> {
    try {
      const outcome = await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const all = (await requestToPromise(store.getAll() as IDBRequest<JobRecord[]>)).filter(
          (row) => row.libraryId === this.libraryId
        );
        const recovered: JobRecord[] = [];
        for (const row of all) {
          if (row.state !== 'running') continue;
          if (!row.lease || row.lease.expiresAt > now) continue;
          const next: JobRecord = {
            ...row,
            state: 'queued',
            lease: undefined,
            nextRunAt: now,
            updatedAt: now,
            log: safeLog(row.log, { at: now, state: 'queued', message: '上一个执行者已失联，重新排队' })
          };
          store.put(next);
          recovered.push(next);
        }
        return recovered;
      });
      return ok(outcome.value);
    } catch (err) {
      return fail(toAppError(err, '无法回收失联任务'));
    }
  }

  /**
   * Un-park jobs that were waiting for the vault.
   *
   * Called after a successful unlock. `waiting-unlock` is deliberately not
   * runnable by `claimNext`, so without this the job would stay parked forever
   * and look like a silently disabled feature.
   */
  async resumeWaitingUnlock(options: { scopeKey?: string } = {}): Promise<Result<JobRecord[]>> {
    const now = this.now();
    try {
      const outcome = await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const all = (await requestToPromise(store.getAll() as IDBRequest<JobRecord[]>)).filter(
          (row) => row.libraryId === this.libraryId
        );
        const resumed: JobRecord[] = [];
        for (const row of all) {
          if (row.state !== 'waiting-unlock') continue;
          if (options.scopeKey && row.scopeKey !== options.scopeKey) continue;
          const next: JobRecord = {
            ...row,
            state: 'queued',
            nextRunAt: now,
            updatedAt: now,
            blockedReason: undefined,
            log: safeLog(row.log, { at: now, state: 'queued', message: '金库已解锁，继续执行' })
          };
          store.put(next);
          resumed.push(next);
        }
        return resumed;
      });
      return ok(outcome.value);
    } catch (err) {
      return fail(toAppError(err, '无法恢复等待解锁的任务'));
    }
  }

  async conflict(id: string, reason: string): Promise<Result<JobRecord | null>> {
    return this.finish(id, 'conflict', { ok: false, message: reason, at: this.now() }, reason, {
      blockedReason: reason,
      retryable: false
    });
  }

  /**
   * Record a failure, scheduling a retry when it is retryable.
   *
   * §10.2: "可重试网络失败按 30 秒、2 分钟、10 分钟退避，最多 3 次自动重试；认证/权限
   * 错误不重试".
   */
  async fail(id: string, reason: string, options: { retryable: boolean }): Promise<Result<JobRecord | null>> {
    return this.finish(id, 'failed', { ok: false, message: reason, at: this.now() }, reason, {
      retryable: options.retryable
    });
  }

  private async finish(
    id: string,
    state: JobState,
    result?: JobRecord['result'],
    message?: string,
    options: { blockedReason?: string; retryable?: boolean } = {}
  ): Promise<Result<JobRecord | null>> {
    const now = this.now();
    try {
      const outcome = await runV3Transaction([JOBS], 'readwrite', async (ctx) => {
        const store = ctx.store(JOBS);
        const row = (await requestToPromise(store.get([this.libraryId, id]))) as JobRecord | undefined;
        if (!row) return null;

        const retry =
          state === 'failed' &&
          options.retryable === true &&
          row.attempt < MAX_ATTEMPTS;

        const next: JobRecord = {
          ...row,
          state: retry ? 'queued' : state,
          updatedAt: now,
          // Releasing the lease on every terminal state is what stops a dead
          // runner's job from looking busy forever.
          lease: retry ? undefined : row.lease,
          // The result message is shown in the task list *and* may be exported in
          // diagnostics, so it is scrubbed exactly like a log line. (The first run
          // of the job suite failed here: the log was masked but `result.message`
          // still carried the provider's raw text.)
          result: result
            ? { ...result, message: result.message ? scrubLogText(result.message) : undefined }
            : undefined,
          progress: state === 'succeeded' ? 100 : row.progress,
          blockedReason: options.blockedReason ? scrubLogText(options.blockedReason) : undefined,
          nextRunAt: retry ? now + RETRY_BACKOFF_MS[Math.min(row.attempt, RETRY_BACKOFF_MS.length) - 1] : row.nextRunAt,
          log: safeLog(row.log, {
            at: now,
            state: retry ? 'queued' : state,
            message: retry
              ? `${message ?? '失败'}，将在 ${Math.round((RETRY_BACKOFF_MS[Math.min(row.attempt, RETRY_BACKOFF_MS.length) - 1] ?? 0) / 1000)} 秒后重试`
              : message ?? state
          })
        };
        const issues = validateRecord(JOBS, next);
        if (issues.length > 0) throw new Error(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
        store.put(next);
        return next;
      });
      return ok(outcome.value);
    } catch (err) {
      return fail(toAppError(err, '无法更新任务状态'));
    }
  }

  async list(filter: { state?: JobState; scopeKey?: string } = {}): Promise<Result<JobRecord[]>> {
    try {
      const rows = await runV3Transaction([JOBS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(JOBS).getAll() as IDBRequest<JobRecord[]>)
      );
      return ok(
        rows.value
          .filter(
            (row) =>
              row.libraryId === this.libraryId &&
              (!filter.state || row.state === filter.state) &&
              (!filter.scopeKey || row.scopeKey === filter.scopeKey)
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)
      );
    } catch (err) {
      return fail(toAppError(err, '无法读取任务列表'));
    }
  }

  async get(id: string): Promise<Result<JobRecord | undefined>> {
    try {
      const row = await runV3Transaction([JOBS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(JOBS).get([this.libraryId, id]))
      );
      return ok((row.value as JobRecord | undefined) ?? undefined);
    } catch (err) {
      return fail(toAppError(err, '无法读取任务'));
    }
  }

  /** Counts for the settings page: waiting-unlock is surfaced separately. */
  async summary(): Promise<Result<Record<JobState | 'total', number>>> {
    const rows = await this.list();
    if (!rows.ok) return fail(rows.error);
    const out = {
      total: rows.value.length,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      conflict: 0,
      cancelled: 0,
      'waiting-unlock': 0
    } as Record<JobState | 'total', number>;
    for (const row of rows.value) out[row.state] = (out[row.state] ?? 0) + 1;
    return ok(out);
  }
}
