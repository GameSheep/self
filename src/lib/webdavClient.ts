/**
 * Minimal WebDAV client (Basic auth).
 *
 * Used as an alternative to OSS for whole-state backup. Two real-world caveats
 * are surfaced honestly instead of being hidden behind a generic "failed":
 *
 * 1. Authentication: InfiniCLOUD/TeraCloud require the *app password* (not the
 *    login password) and the "外部アプリ接続" switch to be enabled.
 * 2. CORS: most WebDAV servers send no `Access-Control-Allow-Origin`, so a normal
 *    web tab cannot call them at all. Extension pages (with host permissions) are
 *    exempt, which is why the diagnostic message mentions the environment.
 */

export interface WebdavConfig {
  enabled: boolean;
  /** Base URL, e.g. https://toi.teracloud.jp/dav/ */
  url: string;
  username: string;
  password: string;
  /** Directory for Self-Hub files, created on demand. */
  pathPrefix?: string;
}

export interface WebdavTestResult {
  ok: boolean;
  status?: number;
  message: string;
  /** How long the probe took, when it succeeded. */
  latencyMs?: number;
}

/** Base64 of a UTF-8 string (btoa alone breaks on non-Latin1 names). */
function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  const clean = path.replace(/^\/+/, '');
  return clean ? `${trimmed}/${clean}` : `${trimmed}/`;
}

function normalizePrefix(prefix?: string): string {
  return (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function authHeaders(config: WebdavConfig): Record<string, string> {
  return { Authorization: `Basic ${toBase64(`${config.username}:${config.password}`)}` };
}

function classifyStatus(status: number): string {
  switch (status) {
    case 200:
    case 207:
      return '';
    case 401:
      return '认证失败（401）：请确认「接続ID」是账号 ID、密码是网页版生成的「应用密码」，且已开启「外部应用连接」';
    case 403:
      return '无权限（403）：该账号被禁止通过外部应用访问';
    case 404:
      return '路径不存在（404）：检查 URL 是否以 /dav/ 结尾';
    case 405:
      return '该地址不支持 WebDAV（405）';
    default:
      return `服务器返回 HTTP ${status}`;
  }
}

function networkFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (
    `无法连接：${message}。` +
    '常见原因：服务器未返回 CORS 头（普通网页会被浏览器拦截，需在扩展环境使用），或网络不可达'
  );
}

/** PROPFIND the base URL — the standard "is this WebDAV usable" probe. */
export async function testWebdav(config: WebdavConfig, timeoutMs = 15000): Promise<WebdavTestResult> {
  if (!config.url.trim()) return { ok: false, message: '请填写 WebDAV 服务器地址' };
  if (!config.username.trim() || !config.password) return { ok: false, message: '请填写连接 ID 与应用密码' };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = Date.now();

  try {
    const res = await fetch(joinUrl(config.url, ''), {
      method: 'PROPFIND',
      headers: { ...authHeaders(config), Depth: '0' },
      signal: controller?.signal,
      cache: 'no-store'
    });
    const latencyMs = Date.now() - started;
    const reason = classifyStatus(res.status);
    if (!reason) {
      const dav = res.headers.get('dav');
      return {
        ok: true,
        status: res.status,
        latencyMs,
        message: dav ? `连接成功（DAV ${dav.split(',').join('.')}），${latencyMs}ms` : `连接成功，${latencyMs}ms`
      };
    }
    return { ok: false, status: res.status, latencyMs, message: reason };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, message: aborted ? `探测超时（>${timeoutMs / 1000}s）` : networkFailure(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Create a collection; 405 means it already exists, which is fine. */
async function ensureCollection(config: WebdavConfig, path: string): Promise<void> {
  try {
    const res = await fetch(joinUrl(config.url, path), {
      method: 'MKCOL',
      headers: authHeaders(config)
    });
    if (!res.ok && res.status !== 405 && res.status !== 409) {
      // 409 = parent missing; caller creates the hierarchy level by level.
      throw new Error(`MKCOL ${path} -> HTTP ${res.status}`);
    }
  } catch (err) {
    // MKCOL is optional on many servers; a failed mkdir surfaces on the PUT.
    if (err instanceof Error && err.message.startsWith('MKCOL')) throw err;
  }
}

function segments(prefix: string): string[] {
  return prefix.split('/').filter(Boolean);
}

/** Ensure `a/b/c` exists, creating each level (servers vary on deep MKCOL). */
async function ensurePath(config: WebdavConfig, prefix: string): Promise<void> {
  const parts = segments(prefix);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    await ensureCollection(config, current);
  }
}

export async function putWebdavFile(
  config: WebdavConfig,
  fileName: string,
  content: string
): Promise<{ ok: boolean; status?: number; message: string; path: string }> {
  const prefix = normalizePrefix(config.pathPrefix);
  const path = prefix ? `${prefix}/${fileName}` : fileName;
  try {
    await ensurePath(config, prefix);
    const res = await fetch(joinUrl(config.url, path), {
      method: 'PUT',
      headers: { ...authHeaders(config), 'Content-Type': 'application/json; charset=utf-8' },
      body: content
    });
    if (!res.ok) {
      return { ok: false, status: res.status, message: classifyStatus(res.status) || `HTTP ${res.status}`, path };
    }
    return { ok: true, status: res.status, message: '已上传', path };
  } catch (err) {
    return { ok: false, message: networkFailure(err), path };
  }
}

export async function getWebdavFile(
  config: WebdavConfig,
  fileName: string
): Promise<{ ok: boolean; status?: number; text?: string; message: string; path: string }> {
  const prefix = normalizePrefix(config.pathPrefix);
  const path = prefix ? `${prefix}/${fileName}` : fileName;
  try {
    const res = await fetch(joinUrl(config.url, path), {
      method: 'GET',
      headers: authHeaders(config),
      cache: 'no-store'
    });
    if (res.status === 404) return { ok: false, status: 404, message: '云端还没有备份', path };
    if (!res.ok) return { ok: false, status: res.status, message: classifyStatus(res.status) || `HTTP ${res.status}`, path };
    return { ok: true, status: res.status, text: await res.text(), message: 'ok', path };
  } catch (err) {
    return { ok: false, message: networkFailure(err), path };
  }
}

/** Human-readable target, shown in settings. */
export function describeWebdavTarget(config: WebdavConfig, fileName = 'state.json'): string {
  const prefix = normalizePrefix(config.pathPrefix);
  return joinUrl(config.url || '(未填写)', prefix ? `${prefix}/${fileName}` : fileName);
}
