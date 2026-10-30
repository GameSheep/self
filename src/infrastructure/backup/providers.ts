/**
 * Backup transports for the two existing providers (P2-05).
 *
 * Both adapters are thin on purpose. All the interesting behaviour — ordering,
 * completion markers, hashing, retention — lives in `writer.ts` and is provider
 * agnostic; these files only translate `BackupTransport` into the calls the P1
 * clients already make, and translate their failure strings into `AppError` codes
 * so the job runner can decide between "retry" and "the user must fix something".
 *
 * The path convention is shared by both: **paths are relative to the root the user
 * configured** (OSS `prefix`, WebDAV `pathPrefix`). That is what makes
 * `.selfhub/v3/<library>/<device>/<generation>/…` meaningful without either
 * adapter knowing what a generation is.
 */
import { appError, type AppError } from '../../repositories/errors';
import type { ObsidianConfig, WebdavSyncConfig } from '../../types';
import {
  deleteOssObject,
  fetchOssObjectBlob,
  hasRealOssKeys,
  headOssObject,
  listOssObjects,
  putOssObject
} from '../../lib/s3Client';
import {
  deleteWebdavPath,
  getWebdavPath,
  listWebdavCollection,
  putWebdavPath,
  toTransportPath
} from '../../lib/webdavClient';
import type { BackupTransport, TransportObject } from './transport';

const OSS_ERROR_MAP: Array<{ match: RegExp; code: AppError['code']; message: string; action?: string }> = [
  { match: /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/i, code: 'AUTH_FAILED', message: 'OSS 拒绝了签名，请检查 AccessKey 是否仍然有效。', action: 'update_connection_secret' },
  { match: /NoSuchBucket/i, code: 'NOT_FOUND', message: '目标 bucket 不存在，请检查 bucket 与 endpoint。' },
  { match: /403/, code: 'FORBIDDEN', message: 'OSS 返回权限不足（403），当前密钥不能写入这个目录。' },
  { match: /CORS|Failed to fetch|NetworkError/i, code: 'NETWORK_UNREACHABLE', message: '无法访问 OSS：可能是跨域(CORS)未放行或网络不可达。', action: 'check_cors_or_use_extension' }
];

function mapOssError(message: string | undefined, fallback = 'OSS 操作失败'): AppError {
  if (!message) return appError('UNKNOWN', fallback, { safeDetail: 'oss unknown error' });
  for (const rule of OSS_ERROR_MAP) {
    if (rule.match.test(message)) {
      return appError(rule.code, rule.message, { safeDetail: message.slice(0, 200), suggestedAction: rule.action });
    }
  }
  return appError('UNKNOWN', fallback, { safeDetail: message.slice(0, 200) });
}

function ossKey(prefix: string, path: string): string {
  const clean = (prefix || '').replace(/^\/+|\/+$/g, '');
  return clean ? `${clean}/${path.replace(/^\/+/, '')}` : path.replace(/^\/+/, '');
}

export class OssBackupTransport implements BackupTransport {
  readonly description: string;
  private readonly config: ObsidianConfig;

  constructor(config: ObsidianConfig) {
    this.config = config;
    const prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '');
    this.description = `${config.bucket}.${(config.endpoint || 'oss').replace(/^https?:\/\//, '')}${prefix ? `/${prefix}` : ''}`;
  }

  static available(config: ObsidianConfig): boolean {
    return hasRealOssKeys(config) && Boolean(config.bucket);
  }

  async put(path: string, body: string, contentType = 'application/json'): Promise<void> {
    const result = await putOssObject(this.config, ossKey(this.config.prefix, path), body, contentType);
    if (!result.success) throw mapOssError(result.error, `无法写入 ${path}`);
  }

  async get(path: string): Promise<string | null> {
    const key = ossKey(this.config.prefix, path);
    const blob = await fetchOssObjectBlob(this.config, key);
    if (blob) return blob.text();
    // `fetchOssObjectBlob` cannot tell "missing" from "failed", and those two
    // need different handling: missing means "no backup here yet", failed means
    // "do not write a completion marker on top of an unreadable object".
    const head = await headOssObject(this.config, key);
    if (head.exists) throw mapOssError(head.error, `对象存在但读取失败：${path}`);
    return null;
  }

  async list(prefix: string): Promise<TransportObject[]> {
    const listed = await listOssObjects(this.config, ossKey(this.config.prefix, prefix));
    if (listed.source === 'error') throw mapOssError(listed.error, '无法列出 OSS 目录');
    const root = (this.config.prefix || '').replace(/^\/+|\/+$/g, '');
    return listed.objects
      .filter((object) => !object.key.endsWith('/'))
      .map((object) => ({
        path: root && object.key.startsWith(`${root}/`) ? object.key.slice(root.length + 1) : object.key,
        size: object.size,
        lastModified: object.lastModified
      }));
  }

  async remove(path: string): Promise<void> {
    const result = await deleteOssObject(this.config, ossKey(this.config.prefix, path));
    if (!result.success) throw mapOssError(result.error, `无法删除 ${path}`);
  }
}

const WEBDAV_ERROR_MAP: Array<{ match: RegExp; code: AppError['code']; message: string; action?: string }> = [
  { match: /401/, code: 'AUTH_FAILED', message: 'WebDAV 认证失败（401），请确认用的是应用密码。', action: 'update_connection_secret' },
  { match: /403/, code: 'FORBIDDEN', message: 'WebDAV 账号被禁止通过外部应用访问（403）。' },
  { match: /404/, code: 'NOT_FOUND', message: 'WebDAV 路径不存在（404）。' },
  { match: /CORS|Failed to fetch|NetworkError/i, code: 'NETWORK_UNREACHABLE', message: '无法访问 WebDAV：服务器可能未返回 CORS 头，或网络不可达。', action: 'use_extension_environment' }
];

function mapWebdavError(message: string | undefined, fallback = 'WebDAV 操作失败'): AppError {
  if (!message) return appError('UNKNOWN', fallback, { safeDetail: 'webdav unknown error' });
  for (const rule of WEBDAV_ERROR_MAP) {
    if (rule.match.test(message)) {
      return appError(rule.code, rule.message, { safeDetail: message.slice(0, 200), suggestedAction: rule.action });
    }
  }
  return appError('UNKNOWN', fallback, { safeDetail: message.slice(0, 200) });
}

export class WebdavBackupTransport implements BackupTransport {
  readonly description: string;
  private readonly config: WebdavSyncConfig;

  constructor(config: WebdavSyncConfig) {
    this.config = config;
    const prefix = (config.pathPrefix || '').replace(/^\/+|\/+$/g, '');
    this.description = `${(config.url || '').replace(/\/+$/, '')}/${prefix ? `${prefix}/` : ''}`;
  }

  static available(config?: WebdavSyncConfig): boolean {
    return Boolean(config && config.url && config.username && config.password);
  }

  async put(path: string, body: string, contentType = 'application/json'): Promise<void> {
    const result = await putWebdavPath(this.config, path, body);
    if (!result.ok) throw mapWebdavError(result.message, `无法写入 ${path}`);
    void contentType;
  }

  async get(path: string): Promise<string | null> {
    const result = await getWebdavPath(this.config, path);
    if (result.ok) return result.text ?? '';
    if (result.status === 404) return null;
    throw mapWebdavError(result.message, `无法读取 ${path}`);
  }

  async list(prefix: string): Promise<TransportObject[]> {
    const clean = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
    // Transport paths are relative to the configured root, so the client's
    // `pathPrefix` has to be added before PROPFINDing. Forgetting it made the
    // listing ask for a collection that does not exist and silently report "no
    // backups" — caught by the WebDAV provider round trip.
    const configured = (this.config.pathPrefix || '').replace(/^\/+|\/+$/g, '');
    const full = (path: string): string => (configured ? (path ? `${configured}/${path}` : configured) : path);
    const collected: TransportObject[] = [];
    // The listing is recursive-ish: PROPFIND Depth 1 per directory level is what
    // every server supports; `Depth: infinity` is widely rejected.
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      const result = await listWebdavCollection(this.config, full(dir));
      if (!result.ok) throw mapWebdavError(result.message, `无法列出 ${dir || '根目录'}`);
      for (const entry of result.entries) {
        const relative = toTransportPath(this.config, entry.path);
        if (relative === undefined) continue;
        const trimmed = relative.replace(/\/+$/, '');
        if (!trimmed) continue;
        if (entry.isCollection) {
          if (trimmed.startsWith(clean) || clean.startsWith(`${trimmed}/`)) {
            await walk(trimmed, depth + 1);
          }
          continue;
        }
        if (clean && !trimmed.startsWith(clean)) continue;
        collected.push({ path: trimmed, size: entry.size, lastModified: entry.lastModified });
      }
    };
    await walk(clean, 0);
    return collected.sort((a, b) => a.path.localeCompare(b.path));
  }

  async remove(path: string): Promise<void> {
    const result = await deleteWebdavPath(this.config, path);
    if (!result.ok) throw mapWebdavError(result.message, `无法删除 ${path}`);
  }
}

/** Pick a transport for a resolved backup target, or explain why none works. */
export function createTransport(options: {
  provider: 'oss' | 'webdav';
  oss?: ObsidianConfig;
  webdav?: WebdavSyncConfig;
}): { ok: true; transport: BackupTransport } | { ok: false; error: AppError } {
  if (options.provider === 'oss') {
    if (!options.oss || !OssBackupTransport.available(options.oss)) {
      return { ok: false, error: appError('VALIDATION', 'OSS 连接信息不完整，无法备份。', { safeDetail: 'oss not configured' }) };
    }
    return { ok: true, transport: new OssBackupTransport(options.oss) };
  }
  if (!WebdavBackupTransport.available(options.webdav)) {
    return { ok: false, error: appError('VALIDATION', 'WebDAV 连接信息不完整，无法备份。', { safeDetail: 'webdav not configured' }) };
  }
  return { ok: true, transport: new WebdavBackupTransport(options.webdav!) };
}
