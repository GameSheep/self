import { ObsidianConfig, ObsidianNote } from '../types';
import { hmacSha1 } from './crypto';

export const SAMPLE_OBSIDIAN_NOTES: ObsidianNote[] = [];

/**
 * Generate Authentic Aliyun OSS Authorization Headers
 * Using Native WebCrypto HMAC-SHA1
 */
async function generateOssAuthHeaders(
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
  bucket: string,
  key: string,
  contentType: string,
  accessKeyId: string,
  accessKeySecret: string
): Promise<Record<string, string>> {
  const gmtDate = new Date().toUTCString();
  const canonicalizedResource = key ? `/${bucket}/${key.replace(/^\/+/, '')}` : `/${bucket}/`;
  const canonicalizedOSSHeaders = '';
  const stringToSign = `${method}\n\n${contentType}\n${gmtDate}\n${canonicalizedOSSHeaders}${canonicalizedResource}`;
  
  const signature = await hmacSha1(accessKeySecret, stringToSign);

  const headers: Record<string, string> = {
    'Date': gmtDate,
    'Authorization': `OSS ${accessKeyId}:${signature}`
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  return headers;
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

  try {
    const headers = await generateOssAuthHeaders(
      'GET',
      config.bucket,
      '',
      '',
      config.accessKeyId,
      config.accessKeySecret
    );
    const testUrl = `https://${config.bucket}.${config.endpoint}/?max-keys=1`;

    const res = await fetch(testUrl, { method: 'GET', headers, mode: 'cors' });
    if (res.ok) {
      return {
        success: true,
        message: `✅ 阿里云 OSS 直连验证成功！CORS 正常，Bucket: ${config.bucket}`,
        isRealOss: true
      };
    } else {
      return {
        success: false,
        message: `OSS 返回 HTTP ${res.status}: 请核对 AccessKey 权限是否包含 AliyunOSSReadOnlyAccess/FullAccess`,
        isRealOss: false
      };
    }
  } catch (err: any) {
    return {
      success: false,
      message: '⚠️ 阿里云 OSS CORS 跨域未放行或网络不可达：请在阿里云 OSS 后台 -> 数据安全 -> 跨域设置 (CORS) 中允许当前访问域名',
      isRealOss: false
    };
  }
}

/**
 * Fetch Note List from Aliyun OSS (or cached)
 */
export async function fetchObsidianNotes(config: ObsidianConfig, cachedNotes?: ObsidianNote[]): Promise<ObsidianNote[]> {
  const hasRealKeys = config.enabled && config.bucket && config.endpoint && config.accessKeyId && !config.accessKeyId.includes('•••');

  if (hasRealKeys) {
    try {
      const headers = await generateOssAuthHeaders(
        'GET',
        config.bucket,
        '',
        '',
        config.accessKeyId,
        config.accessKeySecret
      );
      const url = `https://${config.bucket}.${config.endpoint}/?prefix=${encodeURIComponent(config.prefix || '')}&max-keys=200`;
      const res = await fetch(url, { method: 'GET', headers, mode: 'cors' }).catch(() => null);

      if (res && res.ok) {
        const xmlText = await res.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const contents = xmlDoc.getElementsByTagName('Contents');

        const notes: ObsidianNote[] = [];
        for (let i = 0; i < contents.length; i++) {
          const key = contents[i].getElementsByTagName('Key')[0]?.textContent || '';
          if (key.endsWith('.md')) {
            const size = parseInt(contents[i].getElementsByTagName('Size')[0]?.textContent || '0', 10);
            const lastMod = new Date(contents[i].getElementsByTagName('LastModified')[0]?.textContent || '').getTime();
            const title = key.split('/').pop()?.replace('.md', '') || key;
            
            // Retain any existing cached content for fast reading
            const existing = (cachedNotes || []).find(n => n.key === key);
            notes.push({
              key,
              title,
              path: key,
              size,
              lastModified: lastMod,
              content: existing?.content
            });
          }
        }
        if (notes.length > 0) return notes;
      }
    } catch (e) {
      console.warn('Real OSS fetch failed, falling back to cached/sample:', e);
    }
  }

  if (cachedNotes && cachedNotes.length > 0) {
    return cachedNotes;
  }
  return [];
}

/**
 * Fetch full content of a specific note from Aliyun OSS
 */
export async function fetchObsidianNoteContent(config: ObsidianConfig, key: string): Promise<string | null> {
  const hasRealKeys = config.enabled && config.bucket && config.endpoint && config.accessKeyId && !config.accessKeyId.includes('•••');
  if (hasRealKeys) {
    try {
      const headers = await generateOssAuthHeaders(
        'GET',
        config.bucket,
        key,
        '',
        config.accessKeyId,
        config.accessKeySecret
      );
      const targetUrl = `https://${config.bucket}.${config.endpoint}/${key.replace(/^\/+/, '')}`;
      const res = await fetch(targetUrl, { method: 'GET', headers, mode: 'cors' }).catch(() => null);
      if (res && res.ok) {
        return await res.text();
      }
    } catch (err) {
      console.warn('Direct fetch from OSS failed', err);
    }
  }
  return null;
}

/**
 * Save / Update an existing note in Aliyun OSS & local state
 */
export async function saveObsidianNote(
  config: ObsidianConfig,
  key: string,
  content: string,
  currentNotes: ObsidianNote[]
): Promise<{ success: boolean; notes: ObsidianNote[]; message: string; realOss: boolean }> {
  const noteIndex = currentNotes.findIndex((n) => n.key === key);
  const now = Date.now();
  const title = key.split('/').pop()?.replace('.md', '') || key;

  let ossSynced = false;
  const hasRealKeys = config.enabled && config.bucket && config.endpoint && config.accessKeyId && !config.accessKeyId.includes('•••');

  if (hasRealKeys) {
    try {
      const cleanKey = key.replace(/^\/+/, '');
      const headers = await generateOssAuthHeaders(
        'PUT',
        config.bucket,
        cleanKey,
        'text/markdown; charset=utf-8',
        config.accessKeyId,
        config.accessKeySecret
      );
      const targetUrl = `https://${config.bucket}.${config.endpoint}/${cleanKey}`;
      const res = await fetch(targetUrl, {
        method: 'PUT',
        headers,
        body: content,
        mode: 'cors'
      }).catch(() => null);

      if (res && (res.ok || res.status === 200 || res.status === 204)) {
        ossSynced = true;
      }
    } catch (e) {
      console.warn('Real OSS PUT encountered CORS or network error, cached locally:', e);
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

  const msg = ossSynced
    ? `已直接推送到阿里云 OSS 真实存储桶 (${config.bucket})`
    : hasRealKeys
    ? `已保存至本地安全缓存 (OSS CORS 跨域未放行，请在控制台设置)`
    : `已保存至本地安全缓存 (待填写真实 AccessKey 即可直推 OSS)`;

  return { success: true, notes: newNotes, message: msg, realOss: ossSynced };
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
  const hasRealKeys = config.enabled && config.bucket && config.endpoint && config.accessKeyId && !config.accessKeyId.includes('•••');
  if (hasRealKeys) {
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
      const targetUrl = `https://${config.bucket}.${config.endpoint}/${cleanKey}`;
      await fetch(targetUrl, { method: 'DELETE', headers, mode: 'cors' }).catch(() => null);
    } catch {
      // ignore network errors
    }
  }

  const newNotes = currentNotes.filter((n) => n.key !== key);
  return { success: true, notes: newNotes, message: '已从笔记库中移除' };
}


