/**
 * Failure vocabulary for the repository layer (P2-01).
 * Every write in P2 returns the same result shape and the same error codes, so a
 * caller can branch on `code` instead of parsing a message — and so nothing has
 * · The rule from §7.1 that the type system enforces: a message must never carry a
 */

export type AppErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'LOCKED'
  | 'QUOTA_EXCEEDED'
  | 'UNSUPPORTED_ENV'
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'NETWORK_UNREACHABLE'
  | 'REMOTE_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'MIGRATION_REQUIRED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface AppError {
  code: AppErrorCode;
  /** Shown to the user. */
  userMessage: string;
  /** Extra context safe to keep in a log or a diagnostics export. */
  safeDetail?: string;
  retryable: boolean;
  suggestedAction?: string;
  correlationId?: string;
}

/** Codes that are worth retrying automatically (network-ish only). */
const RETRYABLE: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'NETWORK_UNREACHABLE',
  'QUOTA_EXCEEDED'
]);

export function appError(
  code: AppErrorCode,
  userMessage: string,
  options: { safeDetail?: string; suggestedAction?: string; retryable?: boolean; correlationId?: string } = {}
): AppError {
  return {
    code,
    userMessage,
    safeDetail: options.safeDetail,
    suggestedAction: options.suggestedAction,
    retryable: options.retryable ?? RETRYABLE.has(code),
    correlationId: options.correlationId
  };
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: AppError): Result<T> {
  return { ok: false, error };
}

/**
 * Recognise a storage-quota failure across browsers.
 * Chrome reports `QuotaExceededError`, Firefox `NS_ERROR_DOM_QUOTA_REACHED`, and
 */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: string; code?: number; message?: string };
  if (candidate.name === 'QuotaExceededError' || candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (candidate.code === 22) return true;
  return typeof candidate.message === 'string' && /quota/i.test(candidate.message);
}

/** Raised inside a transaction when a record the caller named does not exist. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'NotFoundError';
  }
}

/** Map an unknown thrown value to the shared error vocabulary. */
export function toAppError(err: unknown, fallbackMessage = '操作失败'): AppError {
  if (err && typeof err === 'object' && 'code' in err && 'userMessage' in err) {
    return err as AppError;
  }
  if (err instanceof NotFoundError) {
    return appError('NOT_FOUND', '这条内容不存在，可能已经被删除。', { safeDetail: err.message.slice(0, 200) });
  }
  if (isQuotaError(err)) {
    return appError(
      'QUOTA_EXCEEDED',
      '本机存储空间不足，本次改动没有写入。请先导出备份，再删除部分手绘或大笔记后重试。',
      { safeDetail: 'quota exceeded', suggestedAction: 'export_backup_then_free_space' }
    );
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  return appError('UNKNOWN', fallbackMessage, { safeDetail: message.slice(0, 200) });
}
