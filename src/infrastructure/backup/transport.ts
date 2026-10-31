/**
 * Backup transport seam (P2-05).
 * The format in `format.ts` must not know whether it is talking to OSS or WebDAV.
 * Two reasons, both from the dev doc:
 */
import { appError, type AppError } from '../../repositories/errors';

export interface TransportObject {
  path: string;
  size?: number;
  lastModified?: number;
}

export interface BackupTransport {
  /** Human-readable destination, safe to show. Never contains a secret. */
  readonly description: string;
  put(path: string, body: string, contentType?: string): Promise<void>;
  /** `null` when the object does not exist; throws for real errors. */
  get(path: string): Promise<string | null>;
  list(prefix: string): Promise<TransportObject[]>;
  remove(path: string): Promise<void>;
}

/**
 * In-memory transport.
 *
 * Used by the self-check suite, and by the "试算" preview in settings: it makes the
 * whole protocol exercisable with no credentials and no network, which is exactly
 * what a test needs to be able to fail for the right reason.
 */
export class MemoryBackupTransport implements BackupTransport {
  readonly description: string;
  private readonly files = new Map<string, { body: string; contentType?: string }>();
  /** When set, the next `put` whose path matches throws — used to test aborts. */
  private failures: Array<{ match: string; error: AppError }> = [];

  constructor(description = '内存（测试用）') {
    this.description = description;
  }

  failNext(match: string, error: AppError = appError('NETWORK_UNREACHABLE', '网络中断。')): void {
    this.failures.push({ match, error });
  }

  keys(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  async put(path: string, body: string, contentType?: string): Promise<void> {
    const failure = this.failures.find((f) => path.includes(f.match));
    if (failure) {
      this.failures = this.failures.filter((f) => f !== failure);
      throw failure.error;
    }
    this.files.set(path, { body, contentType });
  }

  async get(path: string): Promise<string | null> {
    return this.files.has(path) ? this.files.get(path)!.body : null;
  }

  async list(prefix: string): Promise<TransportObject[]> {
    return this.keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ path: key, size: this.files.get(key)!.body.length }));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}
