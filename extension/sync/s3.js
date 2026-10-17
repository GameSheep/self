/**
 * Lightweight AWS S3 & S3-Compatible (Cloudflare R2, MinIO, OSS) client
 * Implements SigV4 authentication via native WebCrypto.
 */

import { sha256Hex, hmacSha256, toHex } from './crypto.js';

export class S3Client {
  constructor(config) {
    this.endpoint = (config.endpoint || 'https://s3.amazonaws.com').replace(/\/+$/, '');
    this.bucket = (config.bucket || '').trim();
    this.region = (config.region || 'auto').trim();
    this.accessKeyId = (config.accessKeyId || '').trim();
    this.secretAccessKey = (config.secretAccessKey || '').trim();
    this.pathPrefix = (config.pathPrefix || 'selfhub_sync').replace(/^\/+|\/+$/g, '');
  }

  formatDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getUTCFullYear();
    const m = pad(date.getUTCMonth() + 1);
    const d = pad(date.getUTCDate());
    const h = pad(date.getUTCHours());
    const min = pad(date.getUTCMinutes());
    const s = pad(date.getUTCSeconds());
    return {
      amzDate: `${y}${m}${d}T${h}${min}${s}Z`,
      dateStamp: `${y}${m}${d}`
    };
  }

  buildUrl(fileKey) {
    const fullPath = this.pathPrefix ? `${this.pathPrefix}/${fileKey.replace(/^\/+/, '')}` : fileKey.replace(/^\/+/, '');
    const cleanEndpoint = this.endpoint.replace(/\/+$/, '');
    
    // Check if endpoint already includes bucket or if path-style
    if (cleanEndpoint.includes(this.bucket)) {
      return {
        url: `${cleanEndpoint}/${encodeURI(fullPath)}`,
        host: new URL(cleanEndpoint).host,
        canonicalUri: `/${fullPath}`
      };
    }

    // Path-style S3 URL: https://endpoint/bucket/path
    const parsed = new URL(cleanEndpoint);
    const canonicalUri = `/${this.bucket}/${fullPath}`;
    return {
      url: `${cleanEndpoint}/${this.bucket}/${encodeURI(fullPath)}`,
      host: parsed.host,
      canonicalUri
    };
  }

  async signRequest(method, urlInfo, payloadStr = '') {
    const now = new Date();
    const { amzDate, dateStamp } = this.formatDate(now);
    const service = 's3';

    const payloadHash = await sha256Hex(payloadStr);

    const headers = {
      'host': urlInfo.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate
    };

    if (method === 'PUT') {
      headers['content-type'] = 'application/json; charset=utf-8';
    }

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      method,
      urlInfo.canonicalUri,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const canonicalHash = await sha256Hex(canonicalRequest);

    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      canonicalHash
    ].join('\n');

    // Generate signing key
    const kDate = await hmacSha256(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = await hmacSha256(kDate, this.region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, 'aws4_request');

    const signature = toHex(await hmacSha256(kSigning, stringToSign));

    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      ...headers,
      'Authorization': authHeader
    };
  }

  async getFile(fileKey) {
    const urlInfo = this.buildUrl(fileKey);
    const headers = await this.signRequest('GET', urlInfo);
    // Strip host header to prevent browser Refused to set unsafe header warning
    const { host, ...fetchHeaders } = headers;

    const resp = await fetch(urlInfo.url, {
      method: 'GET',
      headers: fetchHeaders
    });

    if (resp.status === 404) {
      return null;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`S3 GET Error (${resp.status}): ${errText.slice(0, 200)}`);
    }

    return await resp.text();
  }

  async putFile(fileKey, contentStr) {
    const urlInfo = this.buildUrl(fileKey);
    const headers = await this.signRequest('PUT', urlInfo, contentStr);
    const { host, ...fetchHeaders } = headers;

    const resp = await fetch(urlInfo.url, {
      method: 'PUT',
      headers: fetchHeaders,
      body: contentStr
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`S3 PUT Error (${resp.status}): ${errText.slice(0, 200)}`);
    }

    return true;
  }

  async deleteFile(fileKey) {
    const urlInfo = this.buildUrl(fileKey);
    const headers = await this.signRequest('DELETE', urlInfo);
    const { host, ...fetchHeaders } = headers;

    try {
      await fetch(urlInfo.url, {
        method: 'DELETE',
        headers: fetchHeaders
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  async testConnection() {
    const testKey = `.selfhub_test_${Date.now()}.json`;
    try {
      const testContent = JSON.stringify({ ping: 'pong', time: new Date().toISOString() });
      await this.putFile(testKey, testContent);
      const readBack = await this.getFile(testKey);
      if (!readBack) throw new Error('写入成功但无法读回测试文件');
      // Clean up test file
      await this.deleteFile(testKey);
      return { success: true, message: 'S3 存储桶读写与权限测试完全通过！' };
    } catch (e) {
      // Best-effort cleanup
      this.deleteFile(testKey).catch(() => {});
      return { success: false, message: e.message || 'S3 连接失败' };
    }
  }
}
