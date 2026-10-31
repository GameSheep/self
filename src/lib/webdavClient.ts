/**
 * Minimal WebDAV client (Basic auth).
 * Used as an alternative to OSS for whole-state backup. Two real-world caveats
 * are surfaced honestly instead of being hidden behind a generic "failed":
 */

export interface WebdavConfig {
  enabled: boolean;
  /** Base URL, e.g. https://your-host.example.com/dav/ */
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

/* -------------------------------------------------------------------------- */
/* Nested-path operations (P2-05)                                              */
/* -------------------------------------------------------------------------- */

/**
 * The v3 backup layout is several levels deep
 * (`.selfhub/v3/<library>/<device>/<generation>/objects/…`), so a client that can
 * only write `state.json` at the configured prefix is not enough. These four
 * calls are the minimum a `BackupTransport` needs, and nothing more: no path in
 * them is ever absolute, and each level is created with MKCOL on the way in.
 */
function normalizeRelative(path: string): string {
  const prefix = normalizePrefix(path);
  if (!prefix || prefix.split('/').some((segment) => segment === '..')) {
    throw new Error('WebDAV 路径不合法');
  }
  return prefix;
}

function parentOf(path: string): string {
  const parts = normalizeRelative(path).split('/');
  parts.pop();
  return parts.join('/');
}

export interface WebdavEntry {
  /** Path relative to the client's base URL. */
  path: string;
  size: number;
  lastModified?: number;
  isCollection: boolean;
}

/**
 * PROPFIND a collection with `Depth: 1`.
 *
 * Servers disagree about namespace prefixes (`d:href`, `D:href`, none at all), so
 * the response is walked by `localName` instead of by tag name — the same trick
 * the OSS listing uses, for the same reason.
 */
export async function listWebdavCollection(
  config: WebdavConfig,
  collectionPath: string
): Promise<{ ok: boolean; status?: number; entries: WebdavEntry[]; message: string }> {
  if (!config.url.trim()) return { ok: false, entries: [], message: '请填写 WebDAV 服务器地址' };
  const clean = normalizePrefix(collectionPath);
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
  try {
    const res = await fetch(joinUrl(config.url, clean), {
      method: 'PROPFIND',
      headers: { ...authHeaders(config), Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      cache: 'no-store'
    });
    if (!res.ok) {
      return { ok: false, status: res.status, entries: [], message: classifyStatus(res.status) || `HTTP ${res.status}` };
    }
    const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
    return { ok: true, status: res.status, entries: parseMultistatus(xml), message: 'ok' };
  } catch (err) {
    return { ok: false, entries: [], message: networkFailure(err) };
  }
}

/** Walk a multistatus response into entries, ignoring unknown elements. */
export function parseMultistatus(xml: Document): WebdavEntry[] {
  const all = Array.from(xml.getElementsByTagName('*'));
  const responses = all.filter((element) => element.localName === 'response');
  const entries: WebdavEntry[] = [];
  for (const response of responses) {
    const children = Array.from(response.getElementsByTagName('*'));
    const hrefElement = children.find((element) => element.localName === 'href');
    const href = hrefElement?.textContent?.trim();
    if (!href) continue;
    const isCollection = children.some((element) => element.localName === 'collection');
    const lengthText = children.find((element) => element.localName === 'getcontentlength')?.textContent ?? '';
    const modifiedText = children.find((element) => element.localName === 'getlastmodified')?.textContent ?? '';
    const size = Number.parseInt(lengthText, 10);
    const modified = modifiedText ? new Date(modifiedText).getTime() : NaN;
    let path = href;
    try {
      if (/^https?:\/\//i.test(href)) path = new URL(href).pathname;
    } catch {
      /* a relative href is already a path */
    }
    entries.push({
      path: decodeURIComponent(path),
      size: Number.isFinite(size) ? size : 0,
      lastModified: Number.isFinite(modified) ? modified : undefined,
      isCollection
    });
  }
  return entries;
}

/** PUT a file at a nested relative path, creating every parent collection. */
export async function putWebdavPath(
  config: WebdavConfig,
  relativePath: string,
  content: string
): Promise<{ ok: boolean; status?: number; message: string; path: string }> {
  const prefix = normalizePrefix(config.pathPrefix);
  const path = prefix ? `${prefix}/${normalizeRelative(relativePath)}` : normalizeRelative(relativePath);
  try {
    const parent = parentOf(path);
    if (parent) await ensurePath(config, parent);
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

export async function getWebdavPath(
  config: WebdavConfig,
  relativePath: string
): Promise<{ ok: boolean; status?: number; text?: string; message: string; path: string }> {
  const prefix = normalizePrefix(config.pathPrefix);
  const path = prefix ? `${prefix}/${normalizeRelative(relativePath)}` : normalizeRelative(relativePath);
  try {
    const res = await fetch(joinUrl(config.url, path), {
      method: 'GET',
      headers: authHeaders(config),
      cache: 'no-store'
    });
    if (res.status === 404) return { ok: false, status: 404, message: '对象不存在', path };
    if (!res.ok) return { ok: false, status: res.status, message: classifyStatus(res.status) || `HTTP ${res.status}`, path };
    return { ok: true, status: res.status, text: await res.text(), message: 'ok', path };
  } catch (err) {
    return { ok: false, message: networkFailure(err), path };
  }
}

/** DELETE one file. 404 is reported as success: the caller wanted it gone. */
export async function deleteWebdavPath(
  config: WebdavConfig,
  relativePath: string
): Promise<{ ok: boolean; status?: number; message: string; path: string }> {
  const prefix = normalizePrefix(config.pathPrefix);
  const path = prefix ? `${prefix}/${normalizeRelative(relativePath)}` : normalizeRelative(relativePath);
  try {
    const res = await fetch(joinUrl(config.url, path), {
      method: 'DELETE',
      headers: authHeaders(config)
    });
    if (!res.ok && res.status !== 404) {
      return { ok: false, status: res.status, message: classifyStatus(res.status) || `HTTP ${res.status}`, path };
    }
    return { ok: true, status: res.status, message: '已删除', path };
  } catch (err) {
    return { ok: false, message: networkFailure(err), path };
  }
}

/** Strip the base URL + configured prefix from a href, yielding a transport path. */
export function toTransportPath(config: WebdavConfig, entryPath: string): string | undefined {
  let basePath: string;
  try {
    basePath = new URL(joinUrl(config.url, '')).pathname;
  } catch {
    return undefined;
  }
  const prefix = normalizePrefix(config.pathPrefix);
  const rootPath = prefix ? `${basePath.replace(/\/+$/, '')}/${prefix}/` : basePath;
  if (!entryPath.startsWith(rootPath)) return undefined;
  return entryPath.slice(rootPath.length);
}
