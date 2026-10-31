/**
 * Durable job runner (P2-05).
 * The queue (`jobQueue.ts`) is the storage layer; this is the part that actually
 * runs work. It exists as a separate module because of one requirement that is
 * · easy to violate: **the runner must be reconstructible**. A web page reloads, an
 */
import { appError, toAppError, type AppError } from '../../repositories/errors';
import { JobQueue, type JobRecord } from './jobQueue';

/** What a handler tells the runner to record. */
export type JobOutcome =
  | { type: 'success'; message?: string }
  | { type: 'retry'; message: string; retryable?: boolean }
  | { type: 'blocked'; message: string }
  | { type: 'waiting-unlock'; message: string }
  | { type: 'conflict'; message: string }
  | { type: 'cancelled'; message?: string };

export interface JobContext {
  job: JobRecord;
  /** 0–100. Safe to call often; the queue clamps it. */
  reportProgress(percent: number): Promise<void>;
  /** True once the user has asked this job to stop. */
  isCancelRequested(): Promise<boolean>;
  /** Throws `CANCELLED` when a stop has been requested; call between steps. */
  throwIfCancelled(): Promise<void>;
  /** Integration point for the clock, so retry logic is testable. */
  now(): number;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export interface JobRunRecord {
  id: string;
  kind: string;
  scopeKey: string;
  state: JobRecord['state'];
  attempt: number;
  /** Set when the job was re-queued; the caller can show "will retry at …". */
  nextRunAt?: number;
  message?: string;
}

export interface JobRunSummary {
  claimed: number;
  outcomes: JobRunRecord[];
}

export interface JobRunnerOptions {
  queue: JobQueue;
  /** Identifies this runner's leases; one per tab/worker is enough. */
  owner?: string;
  leaseMs?: number;
  now?: () => number;
  /**
   * Renew the lease while a handler runs. On by default: a long upload must not
   * be reclaimed by a second runner halfway through. Turned off by tests that use
   * a fake clock, where an interval would fight the injected time.
   */
  heartbeat?: boolean;
}

function isAppErrorShaped(value: unknown): value is AppError {
  return Boolean(value && typeof value === 'object' && 'code' in value && 'userMessage' in value);
}

/**
 * §7.1 + §10.2: which errors may be retried automatically.
 *
 * Authentication, permission, validation and "not found" failures need the user
 * to change something, so retrying them would only burn attempts and delay the
 * message they need to see. `LOCKED` is not a failure at all — it is a wait.
 */
export function outcomeFromError(err: unknown): JobOutcome {
  const error = isAppErrorShaped(err) ? err : toAppError(err, '任务执行失败');
  const message = error.userMessage;
  switch (error.code) {
    case 'LOCKED':
      return { type: 'waiting-unlock', message };
    case 'CANCELLED':
      return { type: 'cancelled', message };
    case 'REMOTE_CONFLICT':
    case 'REVISION_CONFLICT':
      return { type: 'conflict', message };
    case 'AUTH_FAILED':
    case 'FORBIDDEN':
    case 'VALIDATION':
    case 'NOT_FOUND':
    case 'UNSUPPORTED_ENV':
    case 'MIGRATION_REQUIRED':
      return { type: 'blocked', message };
    case 'NETWORK_UNREACHABLE':
    case 'QUOTA_EXCEEDED':
      return { type: 'retry', message, retryable: true };
    default:
      // Unknown failures are retried only when the error itself says so; an
      // unrecognised error is not assumed to be transient.
      return error.retryable ? { type: 'retry', message, retryable: true } : { type: 'blocked', message };
  }
}

export class JobRunner {
  private readonly queue: JobQueue;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly heartbeat: boolean;
  private readonly handlers = new Map<string, JobHandler>();

  constructor(options: JobRunnerOptions) {
    this.queue = options.queue;
    this.owner = options.owner ?? `runner-${Math.random().toString(36).slice(2, 8)}`;
    this.leaseMs = options.leaseMs ?? 2 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.heartbeat = options.heartbeat ?? true;
  }

  register(kind: string, handler: JobHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  hasHandler(kind: string): boolean {
    return this.handlers.has(kind);
  }

  /**
   * Run whatever is due right now.
   *
   * Reclaims expired leases first, so a single call is enough after a restart:
   * the caller (page boot, alarm, user click) does not have to know whether the
   * previous runner died or shut down cleanly.
   */
  async runDue(options: { limit?: number; reclaim?: boolean } = {}): Promise<JobRunSummary> {
    const limit = options.limit ?? 5;
    if (options.reclaim !== false) {
      await this.queue.requeueExpired(this.now());
    }

    const outcomes: JobRunRecord[] = [];
    for (let index = 0; index < limit; index += 1) {
      const claimed = await this.queue.claimNext({ owner: this.owner, now: this.now(), leaseMs: this.leaseMs });
      if (!claimed.ok || !claimed.value) break;
      const job = claimed.value;
      outcomes.push(await this.runOne(job));
    }

    return { claimed: outcomes.length, outcomes };
  }

  /** Execute one already-claimed job and record its terminal outcome. */
  private async runOne(job: JobRecord): Promise<JobRunRecord> {
    const handler = this.handlers.get(job.kind);
    const timer = this.startHeartbeat(job.id);

    let outcome: JobOutcome;
    try {
      if (!handler) {
        outcome = {
          type: 'blocked',
          message: `没有注册「${job.kind}」类型的执行器，任务已停止；重新打开页面或更新版本后重试。`
        };
      } else {
        const cancelled: JobOutcome = { type: 'cancelled', message: '用户取消' };
        const wasCancelled = await this.queue.isCancelRequested(job.id);
        outcome =
          wasCancelled.ok && wasCancelled.value
            ? cancelled
            : await handler(this.contextFor(job));
      }
    } catch (err) {
      outcome = outcomeFromError(err);
    } finally {
      if (timer) clearInterval(timer);
    }

    // A cancel request that arrived while the handler was working still wins.
    const latest = await this.queue.isCancelRequested(job.id);
    if (latest.ok && latest.value && outcome.type !== 'cancelled') {
      outcome = { type: 'cancelled', message: '用户取消' };
    }

    return this.record(job, outcome);
  }

  private async record(job: JobRecord, outcome: JobOutcome): Promise<JobRunRecord> {
    switch (outcome.type) {
      case 'success':
        await this.queue.succeed(job.id, outcome.message);
        break;
      case 'retry':
        await this.queue.fail(job.id, outcome.message, { retryable: outcome.retryable !== false });
        break;
      case 'blocked':
        await this.queue.block(job.id, outcome.message);
        break;
      case 'waiting-unlock':
        await this.queue.waitForUnlock(job.id, outcome.message);
        break;
      case 'conflict':
        await this.queue.conflict(job.id, outcome.message);
        break;
      case 'cancelled':
        await this.queue.cancel(job.id, outcome.message ?? '用户取消');
        break;
    }

    // Re-read so the summary reports what is actually stored. If even that read
    // fails, report the pre-run snapshot rather than inventing a state.
    const read = await this.queue.get(job.id);
    const updated = read.ok ? read.value ?? null : null;

    return {
      id: job.id,
      kind: job.kind,
      scopeKey: job.scopeKey,
      state: updated?.state ?? job.state,
      attempt: updated?.attempt ?? job.attempt,
      nextRunAt: updated?.nextRunAt,
      message: updated?.result?.message ?? updated?.blockedReason
    };
  }

  private contextFor(job: JobRecord): JobContext {
    return {
      job,
      reportProgress: async (percent) => {
        await this.queue.reportProgress(job.id, percent);
      },
      isCancelRequested: async () => {
        const read = await this.queue.isCancelRequested(job.id);
        return read.ok && read.value;
      },
      throwIfCancelled: async () => {
        const read = await this.queue.isCancelRequested(job.id);
        if (read.ok && read.value) {
          throw appError('CANCELLED', '已按你的要求取消这次任务。', { safeDetail: 'cancel requested' });
        }
      },
      now: () => this.now()
    };
  }

  /**
   * Keep the lease alive while working.
   *
   * Without this, `leaseMs` doubles as a hard limit on how long a legitimate
   * upload may take: a slow 100 MB backup would be reclaimed and started a second
   * time by the next scan, which is exactly the double-write §10.2 forbids.
   */
  private startHeartbeat(jobId: string): ReturnType<typeof setInterval> | undefined {
    if (!this.heartbeat || this.leaseMs < 1_000 || typeof setInterval !== 'function') return undefined;
    const interval = Math.max(1_000, Math.floor(this.leaseMs / 3));
    return setInterval(() => {
      void this.queue.renewLease(jobId, this.owner, this.leaseMs);
    }, interval);
  }
}

/** Headline for a task list entry, kept in one place so it cannot drift per page. */
export function describeJob(job: Pick<JobRecord, 'state' | 'attempt' | 'blockedReason' | 'nextRunAt'>): string {
  switch (job.state) {
    case 'queued':
      return job.nextRunAt && job.nextRunAt > Date.now() ? '等待重试' : '排队中';
    case 'running':
      return '执行中';
    case 'succeeded':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'conflict':
      return job.blockedReason ? `需要处理冲突：${job.blockedReason}` : '需要处理冲突';
    case 'waiting-unlock':
      return job.blockedReason ? `等待解锁：${job.blockedReason}` : '等待解锁';
    case 'failed':
      return job.attempt > 1 ? `失败（已尝试 ${job.attempt} 次）` : '失败';
    default:
      return job.state;
  }
}
