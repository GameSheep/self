import { ObsidianConfig, ObsidianNote } from '../types';
import { hmacSha1 } from './crypto';

export const SAMPLE_OBSIDIAN_NOTES: ObsidianNote[] = [];

/** Percent-encode a key for use in a URL path, segment by segment. */
export function encodeOssKey(key: string): string {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Generate Authentic Aliyun OSS Authorization Headers (V1 signature).
 *
 * MUST use `x-oss-date`, never `Date`: `Date` is a forbidden header name in the
 * Fetch spec, so the browser silently drops it and OSS answers
 * 403 AccessDenied "OSS authentication requires a valid Date." — a failure that
 * cannot be reproduced by curl/PowerShell, which do send `Date`.
 *
 * Verified against the live service: the signature is built from
 *   VERB \n Content-MD5 \n Content-Type \n <x-oss-date> \n
 *   x-oss-date:<x-oss-date>\n  (CanonicalizedOSSHeaders)
 *   /<bucket>/<key>
 */
async function generateOssAuthHeaders(
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD' | 'POST',
  bucket: string,
  key: string,
  contentType: string,
  accessKeyId: string,
  accessKeySecret: string,
  /** Extra `x-oss-*` headers that must take part in the signature (e.g. x-oss-copy-source). */
  extraOssHeaders?: Record<string, string>
): Promise<Record<string, string>> {
  const ossDate = new Date().toUTCString();
  const canonicalizedResource = key ? `/${bucket}/${key.replace(/^\/+/, '')}` : `/${bucket}/`;

  // CanonicalizedOSSHeaders = sorted `name:value` lines (x-oss-copy-source sorts
  // before x-oss-date), matching what the service reconstructs.
  const allOssHeaders: Record<string, string> = { ...(extraOssHeaders || {}), 'x-oss-date': ossDate };
  const canonicalizedOSSHeaders =
    Object.keys(allOssHeaders)
      .map((name) => name.toLowerCase())
      .sort()
      .map((name) => {
        const original = Object.keys(allOssHeaders).find((k) => k.toLowerCase() === name)!;
        return `${name}:${allOssHeaders[original]}\n`;
      })
      .join('');

  const stringToSign = `${method}\n\n${contentType}\n${ossDate}\n${canonicalizedOSSHeaders}${canonicalizedResource}`;

  const signature = await hmacSha1(accessKeySecret, stringToSign);

  const headers: Record<string, string> = {
    'x-oss-date': ossDate,
    Authorization: `OSS ${accessKeyId}:${signature}`,
    ...(extraOssHeaders || {})
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  return headers;
}

/** Pull `<Code>`/`<Message>` out of an OSS error document. */
async function describeOssError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
    const requestId = /<RequestId>([^<]+)<\/RequestId>/.exec(text)?.[1];
    if (code || message) {
      return `HTTP ${res.status} ${code || ''}${message ? ` - ${message}` : ''}${requestId ? ` (RequestId: ${requestId})` : ''}`;
    }
  } catch {
    // fall through
  }
  return `HTTP ${res.status} ${res.statusText}`;
}

/**
 * Test Live Aliyun OSS Connection & CORS Status
 */
export async function testOssConnection(config: ObsidianConfig): Promise<{
  success: boolean;
  message: string;
  isRealOss: boolean;
}> {
  if (!config.enabled || !config.bucket || !config.endpoint) {
    return {
      success: false,
      message: '请先填写完整的 Bucket 名称与 Endpoint 地址',
      isRealOss: false
    };
  }

  if (!config.accessKeyId || !config.accessKeySecret || config.accessKeyId.includes('•••')) {
    return {
      success: true,
      message: '已启用本地演示/高速缓存模式 (未配置完整 AccessKey 秘钥)',
      isRealOss: false
    };
  }

  const cleanEndpoint = config.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const testUrl = `https://${config.bucket}.${cleanEndpoint}/?max-keys=1`;

  try {
    const headers = await generateOssAuthHeaders(
      'GET',
      config.bucket,
      '',
      '',
      config.accessKeyId,
      config.accessKeySecret
    );

    const res = await fetch(testUrl, { method: 'GET', headers, mode: 'cors' });
    if (res.ok) {
      return {
        success: true,
        // Note: from an extension page (chrome-extension://) CORS never applies,
        // so do not imply it was the thing being validated here.
        message: `✅ 阿里云 OSS 直连验证成功！签名与读写权限正常，Bucket: ${config.bucket}`,
        isRealOss: true
      };
    }

    const detail = await describeOssError(res);
    return {
      success: false,
      message: `❌ OSS 拒绝了本次请求：${detail}\n请核对 AccessKey 权限（AliyunOSSReadOnlyAccess / FullAccess）与该 Bucket 的读写授权。`,
      isRealOss: false
    };
  } catch (err: any) {
    return {
      success: false,
      message:
        '⚠️ 请求未能完成：通常是浏览器跨域(CORS)未放行或网络不可达。\n若你是从 Chrome 扩展内置工作台访问（chrome-extension://），扩展已具备 host 权限、不受 CORS 限制，此时更可能是网络/代理问题；\n若你是从网页版访问，请在 OSS 控制台 → 数据安全 → 跨域设置(CORS) 中允许该访问域名、GET/PUT/DELETE/HEAD 方法与 authorization 头。',
      isRealOss: false
    };
  }
}

export interface OssFetchResult {
  notes: ObsidianNote[];
  /** 'oss' = 来自云端；'oss-empty' = 云端可访问但没有 .md；'error' = 请求失败，返回本地缓存；'cache' = 未配置密钥 */
  source: 'oss' | 'oss-empty' | 'error' | 'cache';
  error?: string;
}

export interface OssObject {
  key: string;
  size: number;
  lastModified: number;
  /** ETag from the listing; used as a conflict token that CORS always exposes. */
  etag?: string;
}

/** Normalise an ETag: OSS returns it quoted in XML but unquoted in headers. */
export function normalizeEtag(value?: string | null): string | undefined {
  if (!value) return undefined;
  return value.replace(/^"+|"+$/g, '');
}

export interface OssListResult {
  /** 全部对象（含子目录、非 .md 文件），已跨页合并 */
  objects: OssObject[];
  source: 'oss' | 'error' | 'cache';
  error?: string;
  /** 前缀过滤下的对象数（等于 objects.length） */
  matchedCount: number;
  /** 未加前缀时桶内的对象总数，用于解释"前缀把内容过滤空了" */
  bucketTotalCount?: number;
  /** 达到安全上限仍有更多数据 */
  truncated: boolean;
  prefixUsed: string;
  /** 列举过程中实际请求的页数 */
  pages: number;
}

/** OSS 单页上限，超过会报错 */
const OSS_PAGE_SIZE = 1000;
/** 安全上限：最多翻 30 页（3 万个对象），避免超大桶把界面拖死 */
const OSS_MAX_PAGES = 30;

function parseLastModified(value: string): number {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : Date.now();
}

async function listOssPage(
  config: ObsidianConfig,
  prefix: string,
  marker: string
): Promise<{ xml: Document; ok: true } | { ok: false; error: string }> {
  const cleanEndpoint = config.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const headers = await generateOssAuthHeaders(
    'GET',
    config.bucket,
    '',
    '',
    config.accessKeyId,
    config.accessKeySecret
  );
  let url = `https://${config.bucket}.${cleanEndpoint}/?max-keys=${OSS_PAGE_SIZE}`;
  if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
  if (marker) url += `&marker=${encodeURIComponent(marker)}`;

  const res = await fetch(url, { method: 'GET', headers, mode: 'cors' });
  if (!res.ok) return { ok: false, error: await describeOssError(res) };
  const xmlText = await res.text();
  return { ok: true, xml: new DOMParser().parseFromString(xmlText, 'text/xml') };
}

/**
 * List every object under a prefix, following pagination.
 *
 * The previous implementation issued a single `max-keys=200` request, so anything
 * beyond the first 200 keys (and anything outside the configured prefix) was
 * invisible no matter how deep the vault was.
 */
export async function listOssObjects(
  config: ObsidianConfig,
  prefixOverride?: string
): Promise<OssListResult> {
  const prefix = prefixOverride !== undefined ? prefixOverride : config.prefix || '';
  const hasRealKeys = hasRealOssKeys(config);

  if (!hasRealKeys) {
    return { objects: [], source: 'cache', matchedCount: 0, truncated: false, prefixUsed: prefix, pages: 0 };
  }

  const objects: OssObject[] = [];
  let marker = '';
  let pages = 0;
  let truncated = false;

  try {
    for (let i = 0; i < OSS_MAX_PAGES; i++) {
      const page = await listOssPage(config, prefix, marker);
      if (!page.ok) {
        return {
          objects: [],
          source: 'error',
          error: page.error,
          matchedCount: 0,
          truncated: false,
          prefixUsed: prefix,
          pages
        };
      }
      pages++;

      const contents = page.xml.getElementsByTagName('Contents');
      for (let c = 0; c < contents.length; c++) {
        const key = contents[c].getElementsByTagName('Key')[0]?.textContent || '';
        if (!key) continue;
        const size = parseInt(contents[c].getElementsByTagName('Size')[0]?.textContent || '0', 10);
        const rawMod = contents[c].getElementsByTagName('LastModified')[0]?.textContent || '';
        objects.push({
          key,
          size: Number.isFinite(size) ? size : 0,
          lastModified: parseLastModified(rawMod),
          etag: normalizeEtag(contents[c].getElementsByTagName('ETag')[0]?.textContent)
        });
      }

      const isTruncated = page.xml.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
      if (!isTruncated) break;

      const nextMarker = page.xml.getElementsByTagName('NextMarker')[0]?.textContent || '';
      // Some responses omit NextMarker; fall back to the last key we saw.
      marker = nextMarker || objects[objects.length - 1]?.key || '';
      if (!marker) break;
      if (i === OSS_MAX_PAGES - 1) truncated = true;
    }

    // When a prefix yields nothing, check the bucket root so the UI can explain
    // that the prefix (not the bucket) is what hid the content.
    let bucketTotalCount: number | undefined;
    if (objects.length === 0 && prefix) {
      const rootPage = await listOssPage(config, '', '');
      if (rootPage.ok) {
        bucketTotalCount = rootPage.xml.getElementsByTagName('Contents').length;
      }
    }

    return {
      objects,
      source: 'oss',
      matchedCount: objects.length,
      bucketTotalCount,
      truncated,
      prefixUsed: prefix,
      pages
    };
  } catch (err: any) {
    return {
      objects: [],
      source: 'error',
      error: err?.message || '网络或 CORS 错误',
      matchedCount: 0,
      truncated: false,
      prefixUsed: prefix,
      pages
    };
  }
}

export interface OssTreeNode {
  name: string;
  /** 完整 key 路径；根节点为空字符串 */
  path: string;
  isDir: boolean;
  size: number;
  lastModified: number;
  /** Conflict token carried from the listing (files only). */
  etag?: string;
  children: OssTreeNode[];
}

/**
 * Build a nested tree from a flat key list.
 * Keys ending in '/' are directory placeholders; their parent chain is created too.
 */
export function buildOssTree(objects: OssObject[]): OssTreeNode {
  const root: OssTreeNode = { name: '', path: '', isDir: true, size: 0, lastModified: 0, children: [] };
  // Keyed by directory path *without* the trailing slash to avoid self-recursion.
  const dirIndex = new Map<string, OssTreeNode>([['', root]]);

  const ensureDir = (rawPath: string): OssTreeNode => {
    const normalized = rawPath.replace(/\/+$/, '');
    if (!normalized) return root;
    const existing = dirIndex.get(normalized);
    if (existing) return existing;

    const segments = normalized.split('/');
    const node: OssTreeNode = {
      name: segments[segments.length - 1],
      path: `${normalized}/`,
      isDir: true,
      size: 0,
      lastModified: 0,
      children: []
    };
    // Register before recursing so a malformed key can never loop forever.
    dirIndex.set(normalized, node);

    const parentPath = segments.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    parent.children.push(node);
    return node;
  };

  for (const obj of objects) {
    if (obj.key.endsWith('/')) {
      const dir = ensureDir(obj.key);
      dir.lastModified = Math.max(dir.lastModified, obj.lastModified);
      continue;
    }
    const segments = obj.key.split('/');
    const fileName = segments.pop() || obj.key;
    const parent = ensureDir(segments.join('/'));
    parent.children.push({
      name: fileName,
      path: obj.key,
      isDir: false,
      size: obj.size,
      lastModified: obj.lastModified,
      etag: obj.etag,
      children: []
    });
  }

  const sortNode = (node: OssTreeNode) => {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    node.children.forEach(sortNode);
  };
  sortNode(root);

  return root;
}

/** Prune a tree down to nodes matching the query, keeping ancestor folders. */
export function filterOssTree(
  nodes: OssTreeNode[],
  query: string,
  extraKeys?: Set<string>
): OssTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const walk = (list: OssTreeNode[]): OssTreeNode[] => {
    const out: OssTreeNode[] = [];
    for (const node of list) {
      if (node.isDir) {
        const kids = walk(node.children);
        if (kids.length > 0) out.push({ ...node, children: kids });
      } else if (
        node.name.toLowerCase().includes(q) ||
        node.path.toLowerCase().includes(q) ||
        extraKeys?.has(node.path)
      ) {
        out.push(node);
      }
    }
    return out;
  };

  return walk(nodes);
}

export function countTreeFiles(nodes: OssTreeNode[]): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  const walk = (list: OssTreeNode[]) => {
    for (const node of list) {
      if (node.isDir) {
        dirs++;
        walk(node.children);
      } else {
        files++;
      }
    }
  };
  walk(nodes);
  return { files, dirs };
}

/** Objects deleted from the vault move here instead of disappearing. */
export const TRASH_PREFIX = '.trash/';

export function isTrashed(key: string): boolean {
  return key.startsWith(TRASH_PREFIX);
}

/** Where a vault key lives once trashed (keeps the original folder structure). */
export function trashKeyFor(key: string): string {
  return `${TRASH_PREFIX}${key.replace(/^\/+/, '')}`;
}

/** Inverse of trashKeyFor: the path a trashed object returns to. */
export function restoreKeyFor(key: string): string {
  return isTrashed(key) ? key.slice(TRASH_PREFIX.length) : key;
}

export interface OssHeadResult {
  exists: boolean;
  /** Server-side last-modified in ms, when the browser exposes the header. */
  lastModified?: number;
  etag?: string;
  error?: string;
}

/**
 * HEAD an object to learn whether the cloud copy changed since we loaded it.
 * Some browsers hide Last-Modified on cross-origin responses unless the bucket
 * exposes it; callers must treat `lastModified === undefined` as "unknown".
 */
export async function headOssObject(config: ObsidianConfig, key: string): Promise<OssHeadResult> {
  if (!hasRealOssKeys(config)) return { exists: false, error: '未配置 OSS AccessKey' };
  try {
    const cleanKey = key.replace(/^\/+/, '');
    const headers = await generateOssAuthHeaders(
      'HEAD',
      config.bucket,
      cleanKey,
      '',
      config.accessKeyId,
      config.accessKeySecret
    );
    const res = await fetch(ossObjectUrl(config, cleanKey), { method: 'HEAD', headers, mode: 'cors' });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { exists: false, error: await describeOssError(res) };

    const rawLastModified = res.headers.get('last-modified') || res.headers.get('Last-Modified');
    const parsed = rawLastModified ? new Date(rawLastModified).getTime() : NaN;
    return {
      exists: true,
      lastModified: Number.isFinite(parsed) ? parsed : undefined,
      etag: normalizeEtag(res.headers.get('etag') || res.headers.get('ETag'))
    };
  } catch (err: any) {
    return { exists: false, error: err?.message || '网络或 CORS 错误' };
  }
}

/** Move a single object into the trash (copy first, so nothing is lost). */
export async function trashOssObject(
  config: ObsidianConfig,
  key: string
): Promise<{ success: boolean; trashedTo?: string; error?: string }> {
  const target = trashKeyFor(key);
  const moved = await moveOssObject(config, key, target);
  return moved.success ? { success: true, trashedTo: target } : { success: false, error: moved.error };
}

/** Move a whole folder into the trash. */
export async function trashOssFolder(
  config: ObsidianConfig,
  prefix: string
): Promise<{ success: boolean; moved: number; failed: number; error?: string }> {
  const clean = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return { success: false, moved: 0, failed: 0, error: '目录路径无效' };
  return moveOssFolder(config, `${clean}/`, `${TRASH_PREFIX}${clean}`);
}

export function addTreeNode(root: OssTreeNode, key: string, size: number, lastModified = Date.now()): OssTreeNode {
  const segments = key.split('/');
  const fileName = segments.pop() || key;

  const walk = (node: OssTreeNode, depth: number): OssTreeNode => {
    if (depth === segments.length) {
      if (node.children.some((c) => c.path === key)) return node; // already present
      const child: OssTreeNode = {
        name: fileName,
        path: key,
        isDir: false,
        size,
        lastModified,
        children: []
      };
      const children = [...node.children, child].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
      return { ...node, children };
    }

    const segment = segments[depth];
    const existing = node.children.find((c) => c.isDir && c.name === segment);
    if (existing) {
      return {
        ...node,
        children: node.children.map((c) => (c === existing ? walk(existing, depth + 1) : c))
      };
    }
    const created: OssTreeNode = {
      name: segment,
      path: `${segments.slice(0, depth + 1).join('/')}/`,
      isDir: true,
      size: 0,
      lastModified: 0,
      children: []
    };
    const updated = walk(created, depth + 1);
    return {
      ...node,
      children: [...node.children, updated].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      })
    };
  };

  return walk(root, 0);
}

/** Collect every path in a tree (used to auto-expand search results). */
export function collectDirPaths(nodes: OssTreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.isDir) {
      acc.push(node.path);
      collectDirPaths(node.children, acc);
    }
  }
  return acc;
}

/** Remove a file (and any folder left empty) from a tree without a full re-list. */
export function removeTreeNode(root: OssTreeNode, key: string): OssTreeNode {
  const walk = (node: OssTreeNode): OssTreeNode => {
    const children: OssTreeNode[] = [];
    for (const child of node.children) {
      if (!child.isDir && child.path === key) continue;
      const next = walk(child);
      if (next.isDir && next.children.length === 0) continue;
      children.push(next);
    }
    return { ...node, children };
  };
  return walk(root);
}

/**
 * Fetch Note List from Aliyun OSS.
 *
 * The result carries its provenance so the UI never claims "已从阿里云 OSS 同步拉取"
 * when it actually fell back to a local cache after a failure.
 */
export async function fetchObsidianNotes(config: ObsidianConfig, cachedNotes?: ObsidianNote[]): Promise<OssFetchResult> {
  const cached = cachedNotes || [];
  const hasRealKeys = hasRealOssKeys(config);

  if (!hasRealKeys) {
    return { notes: cached, source: 'cache' };
  }

  const cleanEndpoint = config.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const prefix = config.prefix || '';

  try {
    const headers = await generateOssAuthHeaders(
      'GET',
      config.bucket,
      '',
      '',
      config.accessKeyId,
      config.accessKeySecret
    );
    const url = `https://${config.bucket}.${cleanEndpoint}/?prefix=${encodeURIComponent(prefix)}&max-keys=200`;
    const res = await fetch(url, { method: 'GET', headers, mode: 'cors' });

    if (!res.ok) {
      return { notes: cached, source: 'error', error: await describeOssError(res) };
    }

    const xmlText = await res.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    const contents = xmlDoc.getElementsByTagName('Contents');

    const notes: ObsidianNote[] = [];
    for (let i = 0; i < contents.length; i++) {
      const key = contents[i].getElementsByTagName('Key')[0]?.textContent || '';
      if (key.endsWith('.md')) {
        const size = parseInt(contents[i].getElementsByTagName('Size')[0]?.textContent || '0', 10);
        const rawMod = contents[i].getElementsByTagName('LastModified')[0]?.textContent || '';
        const parsedMod = new Date(rawMod).getTime();
        const title = key.split('/').pop()?.replace('.md', '') || key;

        // Retain any existing cached content for fast reading
        const existing = cached.find((n) => n.key === key);
        notes.push({
          key,
          title,
          path: key,
          size: Number.isFinite(size) ? size : 0,
          lastModified: Number.isFinite(parsedMod) ? parsedMod : Date.now(),
          content: existing?.content
        });
      }
    }

    if (notes.length === 0) {
      // The bucket is reachable but holds no markdown: keep local cache so the
      // user's locally stored note bodies are not silently discarded.
      return { notes: cached, source: 'oss-empty' };
    }
    return { notes, source: 'oss' };
  } catch (err: any) {
    return {
      notes: cached,
      source: 'error',
      error: err?.message || '网络或 CORS 错误'
    };
  }
}

/**
 * Fetch raw object bytes (images/attachments) as a Blob.
 * A private bucket has no public URL, so the only way to display an embedded
 * image is to fetch it with a signature and hand the browser a blob URL.
 */
export async function fetchOssObjectBlob(config: ObsidianConfig, key: string): Promise<Blob | null> {
  const hasRealKeys = hasRealOssKeys(config);
  if (!hasRealKeys) return null;

  try {
    const cleanKey = key.replace(/^\/+/, '');
    const headers = await generateOssAuthHeaders(
      'GET',
      config.bucket,
      cleanKey,
      '',
      config.accessKeyId,
      config.accessKeySecret
    );
    const cleanEndpoint = config.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const url = `https://${config.bucket}.${cleanEndpoint}/${encodeOssKey(cleanKey)}`;
    const res = await fetch(url, { method: 'GET', headers, mode: 'cors' });
    if (!res.ok) {
      console.warn('OSS object fetch failed:', await describeOssError(res));
      return null;
    }
    return await res.blob();
  } catch (err) {
    console.warn('OSS object fetch error', err);
    return null;
  }
}

function ossObjectUrl(config: ObsidianConfig, key: string): string {
  const cleanKey = key.replace(/^\/+/, '');
  const cleanEndpoint = config.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${config.bucket}.${cleanEndpoint}/${encodeOssKey(cleanKey)}`;
}

export function hasRealOssKeys(config: ObsidianConfig): boolean {
  return Boolean(
    config.enabled &&
      config.bucket &&
      config.endpoint &&
      config.accessKeyId &&
      !config.accessKeyId.includes('•••')
  );
}

/** Upload/replace an object (used for pasted screenshots and local file uploads). */
export async function putOssObject(
  config: ObsidianConfig,
  key: string,
  body: Blob | ArrayBuffer | string,
  contentType: string
): Promise<{ success: boolean; error?: string }> {
  if (!hasRealOssKeys(config)) return { success: false, error: '未配置 OSS AccessKey' };
  try {
    const cleanKey = key.replace(/^\/+/, '');
    const headers = await generateOssAuthHeaders(
      'PUT',
      config.bucket,
      cleanKey,
      contentType,
      config.accessKeyId,
      config.accessKeySecret
    );
    const res = await fetch(ossObjectUrl(config, cleanKey), {
      method: 'PUT',
      headers,
      body: body as BodyInit,
      mode: 'cors'
    });
    if (!res.ok) return { success: false, error: await describeOssError(res) };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || '网络或 CORS 错误' };
  }
}

/** Server-side copy (`x-oss-copy-source` must be signed). */
export async function copyOssObject(
  config: ObsidianConfig,
  sourceKey: string,
  targetKey: string
): Promise<{ success: boolean; error?: string }> {
  if (!hasRealOssKeys(config)) return { success: false, error: '未配置 OSS AccessKey' };
  try {
    const src = sourceKey.replace(/^\/+/, '');
    const dst = targetKey.replace(/^\/+/, '');
    const headers = await generateOssAuthHeaders(
      'PUT',
      config.bucket,
      dst,
      '',
      config.accessKeyId,
      config.accessKeySecret,
      { 'x-oss-copy-source': `/${config.bucket}/${src}` }
    );
    const res = await fetch(ossObjectUrl(config, dst), { method: 'PUT', headers, mode: 'cors' });
    if (!res.ok) return { success: false, error: await describeOssError(res) };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || '网络或 CORS 错误' };
  }
}

/** Move a single object = server-side copy, then delete the source. */
export async function moveOssObject(
  config: ObsidianConfig,
  sourceKey: string,
  targetKey: string
): Promise<{ success: boolean; error?: string }> {
  if (sourceKey === targetKey) return { success: true };
  const copied = await copyOssObject(config, sourceKey, targetKey);
  if (!copied.success) return copied;
  const deleted = await deleteOssObject(config, sourceKey);
  if (!deleted.success) {
    // The copy succeeded, so the data is safe; surface the partial failure.
    return { success: false, error: `已复制到新位置，但旧对象删除失败：${deleted.error}` };
  }
  return { success: true };
}

/** Delete one object without touching local state. */
export async function deleteOssObject(
  config: ObsidianConfig,
  key: string
): Promise<{ success: boolean; error?: string }> {
  if (!hasRealOssKeys(config)) return { success: false, error: '未配置 OSS AccessKey' };
  try {
    const cleanKey = key.replace(/^\/+/, '');
    const headers = await generateOssAuthHeaders(
      'DELETE',
      config.bucket,
      cleanKey,
      '',
      config.accessKeyId,
      config.accessKeySecret
    );
    const res = await fetch(ossObjectUrl(config, cleanKey), { method: 'DELETE', headers, mode: 'cors' });
    if (!res.ok && res.status !== 204) return { success: false, error: await describeOssError(res) };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || '网络或 CORS 错误' };
  }
}

/** Create a folder placeholder object (`prefix/`). */
export async function createOssFolder(
  config: ObsidianConfig,
  folderPath: string
): Promise<{ success: boolean; error?: string }> {
  const normalized = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return { success: false, error: '目录名不能为空' };
  // Zero-byte object whose key ends in '/' is the conventional folder marker.
  return putOssObject(config, `${normalized}/`, new Blob([]), 'application/x-directory');
}

export interface MoveFolderResult {
  success: boolean;
  moved: number;
  failed: number;
  error?: string;
}

/**
 * Move every object under `sourcePrefix` to `targetPrefix`.
 * Copies first, then deletes only the successfully copied objects, so an
 * interruption can never lose data.
 */
export async function moveOssFolder(
  config: ObsidianConfig,
  sourcePrefix: string,
  targetPrefix: string,
  onProgress?: (done: number, total: number) => void
): Promise<MoveFolderResult> {
  const src = sourcePrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const dst = targetPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!src || !dst) return { success: false, moved: 0, failed: 0, error: '目录路径无效' };
  if (dst === src || dst.startsWith(`${src}/`)) {
    return { success: false, moved: 0, failed: 0, error: '不能把目录移动到它自身或其子目录下' };
  }

  const listing = await listOssObjects(config, `${src}/`);
  if (listing.source !== 'oss') {
    return { success: false, moved: 0, failed: 0, error: listing.error || '无法读取源目录' };
  }

  const total = listing.objects.length;
  const copied: string[] = [];
  let failed = 0;

  for (let i = 0; i < listing.objects.length; i++) {
    const obj = listing.objects[i];
    const suffix = obj.key.slice(src.length + 1);
    const result = await copyOssObject(config, obj.key, `${dst}/${suffix}`);
    if (result.success) copied.push(obj.key);
    else failed++;
    onProgress?.(i + 1, total);
  }

  let moveFailed = 0;
  for (const key of copied) {
    const result = await deleteOssObject(config, key);
    if (!result.success) moveFailed++;
  }

  return {
    success: failed === 0 && moveFailed === 0,
    moved: copied.length - moveFailed,
    failed: failed + moveFailed,
    error: failed > 0 ? `有 ${failed} 个对象复制失败，源文件已保留` : undefined
  };
}

/** Delete every object under a prefix (used for "delete folder"). */
export async function deleteOssFolder(
  config: ObsidianConfig,
  prefix: string
): Promise<{ success: boolean; deleted: number; failed: number; error?: string }> {
  const clean = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return { success: false, deleted: 0, failed: 0, error: '目录路径无效' };

  const listing = await listOssObjects(config, `${clean}/`);
  if (listing.source !== 'oss') {
    return { success: false, deleted: 0, failed: 0, error: listing.error || '无法读取目录内容' };
  }

  let deleted = 0;
  let failed = 0;
  for (const obj of listing.objects) {
    const result = await deleteOssObject(config, obj.key);
    if (result.success) deleted++;
    else failed++;
  }
  return {
    success: failed === 0,
    deleted,
    failed,
    error: failed > 0 ? `${failed} 个对象删除失败` : undefined
  };
}

/**
 * Fetch full content of a specific note from Aliyun OSS
 */
export async function fetchObsidianNoteContent(config: ObsidianConfig, key: string): Promise<string | null> {
  const hasRealKeys = hasRealOssKeys(config);
  if (hasRealKeys) {
    try {
      const cleanKey = key.replace(/^\/+/, '');
      const headers = await generateOssAuthHeaders(
        'GET',
        config.bucket,
        cleanKey,
        '',
        config.accessKeyId,
        config.accessKeySecret
      );
      const cleanEndpoint = config.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      // Encode the path but sign the raw key (OSS decodes the path before signing).
      const targetUrl = `https://${config.bucket}.${cleanEndpoint}/${encodeOssKey(cleanKey)}`;
      const res = await fetch(targetUrl, { method: 'GET', headers, mode: 'cors' });
      if (res.ok) {
        return await res.text();
      }
      console.warn('OSS GET object failed:', await describeOssError(res));
    } catch (err) {
      console.warn('Direct fetch from OSS failed', err);
    }
  }
  return null;
}

export interface SaveOptions {
  /** Last-modified of the copy we loaded. When the cloud is newer, we refuse. */
  expectedLastModified?: number;
  /**
   * ETag of the copy we loaded. Used when Last-Modified is not exposed by CORS
   * (the web build), so conflict detection also works outside the extension.
   */
  expectedEtag?: string;
  /** Skip the conflict check (user chose "overwrite anyway"). */
  force?: boolean;
}

export interface SaveResult {
  success: boolean;
  notes: ObsidianNote[];
  message: string;
  realOss: boolean;
  /** Set when the cloud copy changed since we loaded it; nothing was written. */
  conflict?: boolean;
  cloudLastModified?: number;
  /** Last-modified reported after a successful write, for the next save. */
  lastModified?: number;
}

/** Tolerate clock/rounding differences of up to a second. */
const CONFLICT_TOLERANCE_MS = 1500;

/**
 * Save / Update an existing note in Aliyun OSS & local state.
 *
 * Before writing, the cloud object's Last-Modified is compared with the value
 * recorded when the note was loaded. If another client (Obsidian desktop via
 * Remotely Save, another browser tab) wrote in between, the write is refused and
 * a `conflict` result is returned so the user can decide instead of silently
 * losing the other version.
 */
export async function saveObsidianNote(
  config: ObsidianConfig,
  key: string,
  content: string,
  currentNotes: ObsidianNote[],
  options: SaveOptions = {}
): Promise<SaveResult> {
  const noteIndex = currentNotes.findIndex((n) => n.key === key);
  const now = Date.now();
  const title = key.split('/').pop()?.replace('.md', '') || key;

  let ossSynced = false;
  let ossError = '';
  const hasRealKeys = hasRealOssKeys(config);

  if (hasRealKeys) {
    try {
      // 1. Conflict check (skipped when the caller explicitly forces a write).
      let cloudLastModified: number | undefined;
      const wantsCheck =
        !options.force && (options.expectedLastModified !== undefined || options.expectedEtag !== undefined);
      if (wantsCheck) {
        const head = await headOssObject(config, key);
        if (head.exists) {
          cloudLastModified = head.lastModified;

          const mtimeChanged =
            head.lastModified !== undefined &&
            options.expectedLastModified !== undefined &&
            head.lastModified > options.expectedLastModified + CONFLICT_TOLERANCE_MS;

          // ETag is the fallback when Last-Modified is hidden by CORS.
          const etagChanged =
            head.lastModified === undefined &&
            options.expectedEtag !== undefined &&
            head.etag !== undefined &&
            head.etag !== options.expectedEtag;

          if (mtimeChanged || etagChanged) {
            return {
              success: false,
              conflict: true,
              cloudLastModified: head.lastModified,
              notes: currentNotes,
              message: '云端文件已被其他客户端修改，本次保存已中止',
              realOss: false
            };
          }
        }
      }

      // 2. Write.
      const cleanKey = key.replace(/^\/+/, '');
      const headers = await generateOssAuthHeaders(
        'PUT',
        config.bucket,
        cleanKey,
        'text/markdown; charset=utf-8',
        config.accessKeyId,
        config.accessKeySecret
      );
      const cleanEndpoint = config.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const targetUrl = `https://${config.bucket}.${cleanEndpoint}/${encodeOssKey(cleanKey)}`;
      const res = await fetch(targetUrl, {
        method: 'PUT',
        headers,
        body: content,
        mode: 'cors'
      });

      if (res.ok) {
        ossSynced = true;
        // Record the new cloud mtime so the next save compares against it.
        cloudLastModified = Date.now();
      } else {
        ossError = await describeOssError(res);
      }

      if (ossSynced) {
        const updatedNote: ObsidianNote = {
          key,
          title,
          path: key,
          size: new Blob([content]).size,
          lastModified: now,
          content
        };
        const newNotes =
          noteIndex >= 0
            ? currentNotes.map((n, idx) => (idx === noteIndex ? updatedNote : n))
            : [updatedNote, ...currentNotes];
        return {
          success: true,
          notes: newNotes,
          message: `已直接推送到阿里云 OSS 真实存储桶 (${config.bucket})`,
          realOss: true,
          lastModified: cloudLastModified
        };
      }
    } catch (e: any) {
      ossError = e?.message || '网络或 CORS 错误';
    }
  }

  const updatedNote: ObsidianNote = {
    key,
    title,
    path: key,
    size: new Blob([content]).size,
    lastModified: now,
    content
  };

  let newNotes: ObsidianNote[];
  if (noteIndex >= 0) {
    newNotes = currentNotes.map((n, idx) => (idx === noteIndex ? updatedNote : n));
  } else {
    newNotes = [updatedNote, ...currentNotes];
  }

  const msg = hasRealKeys
    ? `⚠️ 未能推送到 OSS（${ossError || 'CORS 未放行'}），内容只保存在本地缓存，尚未上云`
    : `已保存至本地安全缓存 (待填写真实 AccessKey 即可直推 OSS)`;

  return { success: ossSynced || !hasRealKeys, notes: newNotes, message: msg, realOss: ossSynced };
}

/**
 * Create a new note in Aliyun OSS
 */
export async function createObsidianNote(
  config: ObsidianConfig,
  path: string,
  content: string,
  currentNotes: ObsidianNote[]
): Promise<{ success: boolean; note: ObsidianNote; notes: ObsidianNote[]; message: string; realOss: boolean }> {
  let cleanPath = path.trim().replace(/^\/+/, '');
  if (!cleanPath.endsWith('.md')) {
    cleanPath += '.md';
  }
  const prefix = config.prefix ? config.prefix.replace(/\/+$/, '') + '/' : '';
  const fullKey = cleanPath.startsWith(prefix) ? cleanPath : prefix + cleanPath;
  const title = cleanPath.split('/').pop()?.replace('.md', '') || cleanPath;

  const res = await saveObsidianNote(config, fullKey, content, currentNotes);
  const created = res.notes.find((n) => n.key === fullKey)!;

  return {
    success: true,
    note: created,
    notes: res.notes,
    message: res.message,
    realOss: res.realOss
  };
}

/**
 * Delete a note from OSS & local cache
 */
export async function deleteObsidianNote(
  config: ObsidianConfig,
  key: string,
  currentNotes: ObsidianNote[]
): Promise<{ success: boolean; notes: ObsidianNote[]; message: string }> {
  const configured = hasRealOssKeys(config);
  let remoteDeleted = false;
  let remoteError = '';

  if (configured) {
    const result = await deleteOssObject(config, key);
    remoteDeleted = result.success;
    remoteError = result.error || '';
  }

  const newNotes = currentNotes.filter((n) => n.key !== key);
  const message = !configured
    ? '已从本地笔记库中移除（未配置 OSS，云端未变动）'
    : remoteDeleted
    ? '已从阿里云 OSS 与本地笔记库中移除'
    : `⚠️ 本地已移除，但云端删除失败（${remoteError || '未知错误'}），该文件仍在 OSS 中`;

  return { success: !configured || remoteDeleted, notes: newNotes, message };
}




