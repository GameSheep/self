import type { Page } from '@playwright/test';

/**
 * Minimal mocked OSS bucket for backup/restore specs.
 * Serves the four things the P1 OSS client actually does — bucket listing with
 */
export interface OssMock {
  files: Map<string, string>;
  captured: Array<{ method: string; path: string; body?: string }>;
}

export interface MockOssOptions {
  bucket: string;
  endpoint: string;
}

export async function mockOss(page: Page, options: MockOssOptions): Promise<OssMock> {
  const files = new Map<string, string>();
  const captured: Array<{ method: string; path: string; body?: string }> = [];
  const { bucket, endpoint } = options;

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (!url.includes(endpoint)) {
      await route.continue();
      return;
    }
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag,Last-Modified',
      'Content-Type': 'application/xml'
    };
    const decoded = decodeURIComponent(url);
    const afterBucket = decoded.split(`${bucket}.${endpoint}/`)[1] ?? '';
    const path = afterBucket.split('?')[0];
    const query = afterBucket.includes('?') ? afterBucket.slice(afterBucket.indexOf('?') + 1) : '';
    const method = request.method();

    if (method === 'GET' && !path) {
      const prefix = new URLSearchParams(query).get('prefix') ?? '';
      const contents = Array.from(files.keys())
        .filter((key) => key.startsWith(prefix))
        .map(
          (key) =>
            `<Contents><Key>${key}</Key><Size>${files.get(key)!.length}</Size>` +
            `<LastModified>${new Date().toUTCString()}</LastModified><ETag>"e"</ETag></Contents>`
        )
        .join('');
      captured.push({ method: 'GET-LIST', path: prefix });
      await route.fulfill({
        status: 200,
        headers: cors,
        body:
          '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
          `<Name>${bucket}</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}` +
          '</ListBucketResult>'
      });
      return;
    }

    if (method === 'PUT') {
      const body = request.postData() ?? '';
      captured.push({ method: 'PUT', path, body });
      files.set(path, body);
      await route.fulfill({ status: 200, headers: { ...cors, ETag: '"new"' }, body: '' });
      return;
    }

    if (method === 'DELETE') {
      captured.push({ method: 'DELETE', path });
      files.delete(path);
      await route.fulfill({ status: 204, headers: cors, body: '' });
      return;
    }

    if (method === 'HEAD') {
      captured.push({ method: 'HEAD', path });
      const exists = files.has(path);
      await route.fulfill({
        status: exists ? 200 : 404,
        headers: exists ? { ...cors, 'Last-Modified': new Date().toUTCString(), ETag: '"e"' } : cors,
        body: ''
      });
      return;
    }

    captured.push({ method: 'GET', path });
    const stored = files.get(path);
    if (stored === undefined) {
      await route.fulfill({ status: 404, headers: cors, body: '' });
      return;
    }
    await route.fulfill({ status: 200, headers: cors, body: stored });
  });

  return { files, captured };
}
