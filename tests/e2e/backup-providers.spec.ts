import { test, expect } from '@playwright/test';
import { resetApp } from './helpers';

/**
 * P2-05: the v3 backup protocol through the **real** provider transports.
 *
 * `backup-v3.spec.ts` proves the format with an in-memory transport. This spec
 * proves the same protocol survives the actual OSS and WebDAV clients — signing,
 * bucket listing, PROPFIND, MKCOL, DELETE and error mapping — against a server
 * mocked at the network layer. "Works with a stub" is not evidence for a backup
 * that has to work against a real bucket.
 */

const OSS_ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const OSS_BUCKET = 'selfhub-backup-test';
const OSS_PREFIX = 'vault/';
const DAV_URL = 'https://dav.example.com/dav/';
const DAV_PREFIX = 'selfhub';

interface CapturedRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: string;
}

/** Mock object store shared by both providers, keyed by remote path. */
function createRemote() {
  const files = new Map<string, string>();
  return {
    files,
    put: (path: string, body: string) => files.set(path, body),
    get: (path: string) => files.get(path),
    remove: (path: string) => files.delete(path),
    keys: () => Array.from(files.keys()).sort()
  };
}

async function mockOss(page: any, captured: CapturedRequest[]) {
  const remote = createRemote();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (!url.includes(OSS_ENDPOINT)) {
      await route.continue();
      return;
    }
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag,Last-Modified',
      'Content-Type': 'application/xml'
    };
    const decoded = decodeURIComponent(url);
    const afterBucket = decoded.split(`${OSS_BUCKET}.${OSS_ENDPOINT}/`)[1] ?? '';
    const path = afterBucket.split('?')[0];
    const query = afterBucket.includes('?') ? afterBucket.slice(afterBucket.indexOf('?') + 1) : '';
    const method = request.method();

    if (method === 'GET' && !path) {
      // Bucket listing: honour the prefix the client asked for.
      const params = new URLSearchParams(query);
      const prefix = params.get('prefix') ?? '';
      captured.push({ method: 'GET-LIST', path, authorization: request.headers()['authorization'] });
      const contents = remote
        .keys()
        .filter((key) => key.startsWith(prefix))
        .map(
          (key) =>
            `<Contents><Key>${key}</Key><Size>${remote.get(key)!.length}</Size>` +
            `<LastModified>${new Date().toUTCString()}</LastModified><ETag>"e"</ETag></Contents>`
        )
        .join('');
      await route.fulfill({
        status: 200,
        headers: cors,
        body:
          '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
          `<Name>${OSS_BUCKET}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}` +
          '</ListBucketResult>'
      });
      return;
    }

    if (method === 'PUT') {
      const body = request.postData() ?? '';
      captured.push({ method: 'PUT', path, authorization: request.headers()['authorization'], body });
      remote.put(path, body);
      await route.fulfill({ status: 200, headers: { ...cors, ETag: '"new"' }, body: '' });
      return;
    }

    if (method === 'DELETE') {
      captured.push({ method: 'DELETE', path, authorization: request.headers()['authorization'] });
      remote.remove(path);
      await route.fulfill({ status: 204, headers: cors, body: '' });
      return;
    }

    if (method === 'HEAD') {
      captured.push({ method: 'HEAD', path, authorization: request.headers()['authorization'] });
      if (remote.get(path) !== undefined) {
        await route.fulfill({
          status: 200,
          headers: { ...cors, 'Last-Modified': new Date().toUTCString(), ETag: '"e"' },
          body: ''
        });
      } else {
        await route.fulfill({ status: 404, headers: cors, body: '' });
      }
      return;
    }

    // GET one object.
    const stored = remote.get(path);
    captured.push({ method: 'GET', path, authorization: request.headers()['authorization'] });
    if (stored === undefined) {
      await route.fulfill({ status: 404, headers: cors, body: '' });
      return;
    }
    await route.fulfill({ status: 200, headers: cors, body: stored });
  });

  return remote;
}

async function mockWebdav(page: any, captured: CapturedRequest[]) {
  const remote = createRemote();
  const basePath = new URL(DAV_URL).pathname; // /dav/

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.hostname.includes('dav.example.com')) {
      await route.continue();
      return;
    }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/xml' };
    const method = request.method();
    const remotePath = decodeURIComponent(url.pathname).slice(basePath.length).replace(/^\/+/, '');
    captured.push({ method, path: remotePath, body: request.postData() ?? undefined });

    if (method === 'PROPFIND') {
      const collectionPath = remotePath.replace(/\/+$/, '');
      const prefix = collectionPath ? `${collectionPath}/` : '';
      const children = new Map<string, { collection: boolean; size: number }>();
      for (const key of remote.keys()) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        const [first, ...rest] = remainder.split('/');
        if (!first) continue;
        if (rest.length > 0) children.set(`${prefix}${first}/`, { collection: true, size: 0 });
        else children.set(key, { collection: false, size: remote.get(key)!.length });
      }
      const responses = [
        `<d:response><d:href>${basePath}${prefix}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        ...Array.from(children.entries()).map(([path, meta]) =>
          meta.collection
            ? `<d:response><d:href>${basePath}${path}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
            : `<d:response><d:href>${basePath}${path}</d:href><d:propstat><d:prop>` +
              `<d:resourcetype/><d:getcontentlength>${meta.size}</d:getcontentlength>` +
              `<d:getlastmodified>${new Date().toUTCString()}</d:getlastmodified>` +
              `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
        )
      ].join('');
      await route.fulfill({
        status: 207,
        headers: { ...cors, DAV: '1,2' },
        body: `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`
      });
      return;
    }

    if (method === 'MKCOL') {
      await route.fulfill({ status: 201, headers: cors, body: '' });
      return;
    }

    if (method === 'PUT') {
      remote.put(remotePath, request.postData() ?? '');
      await route.fulfill({ status: 201, headers: cors, body: '' });
      return;
    }

    if (method === 'DELETE') {
      remote.remove(remotePath);
      await route.fulfill({ status: 204, headers: cors, body: '' });
      return;
    }

    const stored = remote.get(remotePath);
    if (stored === undefined) {
      await route.fulfill({ status: 404, headers: cors, body: '' });
      return;
    }
    await route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: stored });
  });

  return remote;
}

test.describe('P2-05 真实提供商传输', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
    await resetApp(page);
  });

  test('OSS：签名 PUT 写入 v3 批次、列目录、删除都走真实客户端', async ({ page }) => {
    const captured: CapturedRequest[] = [];
    const remote = await mockOss(page, captured);

    const outcome = await page.evaluate(
      ([bucket, endpoint, prefix, runId]) =>
        window.__selfhubContract!.backup.providerRoundTrip({
          kind: 'oss',
          config: {
            bucket,
            endpoint,
            region: 'cn-beijing',
            accessKeyId: 'LTAI5tTestKeyForSigning',
            accessKeySecret: 'test-secret-value',
            prefix
          },
          libraryId: `lib-${runId}`,
          deviceId: `dev-${runId}`,
          password: 'backup-password'
        }),
      [OSS_BUCKET, OSS_ENDPOINT, OSS_PREFIX, `oss${Date.now()}`] as const
    );

    const failed = (outcome.report?.steps ?? []).filter((step) => !step.ok);
    expect(failed, failed.map((step) => `${step.name} → ${step.detail}`).join('\n')).toEqual([]);
    expect(outcome.report?.steps.length).toBe(6);
    expect(outcome.report?.leftovers).toBe(0);
    expect(outcome.report?.latestDescription).toContain('gen-provider-1');

    // The requests really were signed OSS requests under the configured prefix.
    const puts = captured.filter((entry) => entry.method === 'PUT');
    expect(puts.length).toBeGreaterThan(0);
    for (const put of puts) {
      expect(put.authorization ?? '', '每个 PUT 都应带 OSS 签名').toContain('OSS ');
      expect(put.path.startsWith(OSS_PREFIX), `对象应写在配置的前缀下：${put.path}`).toBe(true);
    }
    expect(captured.some((entry) => entry.method === 'GET-LIST')).toBe(true);
    expect(captured.some((entry) => entry.method === 'DELETE')).toBe(true);

    // Nothing uploaded in plain text: the manifest carries file names and titles.
    const plain = captured.filter((entry) => (entry.body ?? '').includes('示例站点'));
    expect(plain.map((entry) => entry.path)).toEqual([]);
    expect(puts.some((entry) => (entry.body ?? '').includes('"ciphertext"'))).toBe(true);
    // Cleanup really removed everything the run wrote.
    expect(remote.keys().filter((key) => key.includes('.selfhub/v3/'))).toEqual([]);
  });

  test('WebDAV：PROPFIND/MKCOL/PUT/DELETE 全流程可用，批次写完即被校验', async ({ page }) => {
    const captured: CapturedRequest[] = [];
    const remote = await mockWebdav(page, captured);

    const outcome = await page.evaluate(
      ([url, pathPrefix, runId]) =>
        window.__selfhubContract!.backup.providerRoundTrip({
          kind: 'webdav',
          config: { url, username: 'tester', password: 'app-password', pathPrefix },
          libraryId: `lib-${runId}`,
          deviceId: `dev-${runId}`,
          password: 'backup-password'
        }),
      [DAV_URL, DAV_PREFIX, `dav${Date.now()}`] as const
    );

    const failed = (outcome.report?.steps ?? []).filter((step) => !step.ok);
    expect(failed, failed.map((step) => `${step.name} → ${step.detail}`).join('\n')).toEqual([]);
    expect(outcome.report?.steps.length).toBe(6);
    expect(outcome.report?.leftovers).toBe(0);
    expect(outcome.report?.latestDescription).toContain('gen-provider-1');

    const methods = captured.map((entry) => entry.method);
    expect(methods).toContain('PROPFIND');
    expect(methods).toContain('MKCOL');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    // Every nested path lives under the configured prefix.
    for (const put of captured.filter((entry) => entry.method === 'PUT')) {
      expect(put.path.startsWith(`${DAV_PREFIX}/.selfhub/v3/`), `路径应在配置前缀下：${put.path}`).toBe(true);
    }
    const plain = captured.filter((entry) => (entry.body ?? '').includes('示例站点'));
    expect(plain.map((entry) => entry.path)).toEqual([]);
    expect(remote.keys().filter((key) => key.includes('.selfhub/v3/'))).toEqual([]);
  });

  test('只配 WebDAV 时使用 WebDAV 传输，不需要 OSS 字段', async ({ page }) => {
    // The P1 regression was "automatic backup only looked at OSS fields". At the
    // v3 layer the same mistake would mean "no transport at all"; this asserts the
    // WebDAV-only configuration produces a working transport.
    const captured: CapturedRequest[] = [];
    await mockWebdav(page, captured);

    const outcome = await page.evaluate(
      ([url, pathPrefix, runId]) =>
        window.__selfhubContract!.backup.providerRoundTrip({
          kind: 'webdav',
          config: { url, username: 'tester', password: 'app-password', pathPrefix },
          libraryId: `lib-${runId}`,
          deviceId: `dev-${runId}`,
          password: 'backup-password'
        }),
      [DAV_URL, DAV_PREFIX, `only${Date.now()}`] as const
    );

    expect(outcome.ok, JSON.stringify(outcome.report?.steps)).toBe(true);
    expect(captured.some((entry) => entry.method === 'PUT')).toBe(true);
    expect(captured.every((entry) => !entry.path.includes('aliyuncs'))).toBe(true);
  });
});
