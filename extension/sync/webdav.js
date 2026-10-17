/**
 * Standard WebDAV client using native browser fetch and Basic Auth.
 * Compatible with Jianguoyun (坚果云), Nextcloud, InfiniCLOUD, AList, Synology, etc.
 */

export class WebDAVClient {
  constructor(config) {
    this.serverUrl = (config.serverUrl || '').replace(/\/+$/, '');
    this.username = (config.username || '').trim();
    this.password = (config.password || '').trim();
    this.pathPrefix = (config.pathPrefix || 'selfhub_sync').replace(/^\/+|\/+$/g, '');
  }

  getAuthHeader() {
    // UTF-8 safe base64 encoding for passwords with special characters
    const str = `${this.username}:${this.password}`;
    const base64 = btoa(unescape(encodeURIComponent(str)));
    return `Basic ${base64}`;
  }

  buildUrl(fileKey) {
    const fullPath = this.pathPrefix ? `${this.pathPrefix}/${fileKey.replace(/^\/+/, '')}` : fileKey.replace(/^\/+/, '');
    return `${this.serverUrl}/${encodeURI(fullPath)}`;
  }

  async ensureDirectory() {
    if (!this.pathPrefix) return;
    const segments = this.pathPrefix.split('/').filter(Boolean);
    let currentPath = '';

    for (const seg of segments) {
      currentPath += `${seg}/`;
      const dirUrl = `${this.serverUrl}/${encodeURI(currentPath)}`;
      try {
        await fetch(dirUrl, {
          method: 'MKCOL',
          headers: {
            'Authorization': this.getAuthHeader()
          }
        });
      } catch (_) {
        // Ignore 405 Method Not Allowed if directory already exists
      }
    }
  }

  async getFile(fileKey) {
    const url = this.buildUrl(fileKey);
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': this.getAuthHeader()
      }
    });

    if (resp.status === 404) {
      return null;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`WebDAV GET Error (${resp.status}): ${errText.slice(0, 200)}`);
    }

    return await resp.text();
  }

  async putFile(fileKey, contentStr) {
    await this.ensureDirectory();
    const url = this.buildUrl(fileKey);
    let resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': this.getAuthHeader(),
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: contentStr
    });

    if (resp.status === 409 || resp.status === 404) {
      // Try ensuring directory and retry once
      await this.ensureDirectory();
      resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': this.getAuthHeader(),
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: contentStr
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`WebDAV PUT Error (${resp.status}): ${errText.slice(0, 200)}`);
    }

    return true;
  }

  async deleteFile(fileKey) {
    const url = this.buildUrl(fileKey);
    try {
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': this.getAuthHeader()
        }
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
      return { success: true, message: 'WebDAV 读写与权限测试完全通过！' };
    } catch (e) {
      this.deleteFile(testKey).catch(() => {});
      return { success: false, message: e.message || 'WebDAV 连接失败' };
    }
  }
}
