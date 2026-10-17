/**
 * SyncManager: Central coordinator for S3 / WebDAV synchronization.
 * Handles debouncing, locking, merging, and sync state reporting.
 */

import { S3Client } from './s3.js';
import { WebDAVClient } from './webdav.js';
import { DataMerger } from './merger.js';

let isSyncingLock = false;

export class SyncManager {
  static async getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['selfhub_sync_config', 'selfhub_sync_status'], (res) => {
        resolve({
          config: res.selfhub_sync_config || {
            provider: 'none',
            autoSync: true,
            cooldownSec: 60,
            s3: {},
            webdav: {}
          },
          status: res.selfhub_sync_status || {
            state: 'idle',
            lastSyncTime: 0,
            lastMessage: '未曾同步'
          }
        });
      });
    });
  }

  static async saveConfig(newConfig) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ selfhub_sync_config: newConfig }, () => resolve(true));
    });
  }

  static async updateStatus(statusPatch) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['selfhub_sync_status'], (res) => {
        const updated = { ...(res.selfhub_sync_status || {}), ...statusPatch };
        chrome.storage.local.set({ selfhub_sync_status: updated }, () => {
          // Notify any listening pages (NewTab, Popup, Options)
          try {
            chrome.runtime.sendMessage({ action: 'SYNC_STATUS_CHANGED', status: updated }).catch(() => {});
          } catch (_) {}
          resolve(updated);
        });
      });
    });
  }

  static getClient(config) {
    if (!config || config.provider === 'none') return null;
    if (config.provider === 's3') {
      return new S3Client(config.s3 || {});
    }
    if (config.provider === 'webdav') {
      return new WebDAVClient(config.webdav || {});
    }
    return null;
  }

  static async testConnection(provider, subConfig) {
    const client = provider === 's3' 
      ? new S3Client(subConfig) 
      : new WebDAVClient(subConfig);
    return await client.testConnection();
  }

  /**
   * Main sync workflow
   */
  static async performSync({ force = false } = {}) {
    if (isSyncingLock) {
      return { success: false, message: '同步任务正在进行中，请勿重复触发' };
    }

    const { config, status } = await this.getConfig();
    if (!config || config.provider === 'none') {
      return { success: false, message: '尚未配置云同步提供商' };
    }

    const now = Date.now();
    const cooldownMs = (config.cooldownSec || 60) * 1000;
    if (!force && (now - (status.lastSyncTime || 0) < cooldownMs)) {
      return { success: true, message: '处于防抖冷却期内，跳过重复同步' };
    }

    isSyncingLock = true;
    await this.updateStatus({ state: 'syncing', lastMessage: '正在连接云端并比对数据...' });

    try {
      const client = this.getClient(config);
      if (!client) throw new Error('无效的存储客户端配置');

      // 1. Read local data
      const localData = await new Promise((resolve) => {
        chrome.storage.local.get([
          'selfhub_annotations',
          'selfhub_inbox',
          'selfhub_sites',
          'selfhub_quicknote',
          'selfhub_quicknote_updatedAt'
        ], resolve);
      });

      const localAnnotations = localData.selfhub_annotations || [];
      const localInbox = localData.selfhub_inbox || [];
      const localSites = localData.selfhub_sites || [];
      const localQuickNote = {
        content: localData.selfhub_quicknote || '',
        updatedAt: localData.selfhub_quicknote_updatedAt || 0
      };

      // 2. Fetch remote manifest
      let remoteManifest = null;
      try {
        const manifestRaw = await client.getFile('manifest.json');
        if (manifestRaw) {
          remoteManifest = JSON.parse(manifestRaw);
        }
      } catch (err) {
        console.warn('[Sync] Read remote manifest failed, treating as first sync:', err);
      }

      // 3. Fetch remote files if present
      let remoteAnnotations = [];
      let remoteInbox = [];
      let remoteSites = [];
      let remoteQuickNote = { content: '', updatedAt: 0 };

      if (remoteManifest) {
        const [rawAnn, rawInbox, rawSites, rawNote] = await Promise.all([
          client.getFile('annotations.json').catch(() => null),
          client.getFile('inbox.json').catch(() => null),
          client.getFile('sites.json').catch(() => null),
          client.getFile('quicknote.json').catch(() => null)
        ]);

        if (rawAnn) remoteAnnotations = JSON.parse(rawAnn);
        if (rawInbox) remoteInbox = JSON.parse(rawInbox);
        if (rawSites) remoteSites = JSON.parse(rawSites);
        if (rawNote) remoteQuickNote = JSON.parse(rawNote);
      }

      // 4. Merge data with Tombstone + LWW
      const annResult = DataMerger.mergeItemList(localAnnotations, remoteAnnotations, 'annotations');
      const inboxResult = DataMerger.mergeItemList(localInbox, remoteInbox, 'inbox');
      const sitesResult = DataMerger.mergeItemList(localSites, remoteSites, 'sites');
      const noteResult = DataMerger.mergeQuickNote(localQuickNote, remoteQuickNote);

      // Mass deletion circuit breaker protection (skip if force sync)
      if (remoteManifest && !force) {
        const localActiveAnn = localAnnotations.filter(a => !a.isDeleted).length;
        const remoteActiveAnn = remoteAnnotations.filter(a => !a.isDeleted).length;
        const safety = DataMerger.checkMassDeletionSafety(localActiveAnn, remoteActiveAnn);
        if (!safety.safe) {
          throw new Error(safety.warning);
        }
      }

      // 5. Update local storage with merged results
      await new Promise((resolve) => {
        chrome.storage.local.set({
          selfhub_annotations: annResult.mergedList,
          selfhub_inbox: inboxResult.mergedList,
          selfhub_sites: sitesResult.mergedList,
          selfhub_quicknote: noteResult.content,
          selfhub_quicknote_updatedAt: noteResult.updatedAt
        }, resolve);
      });

      // 6. Upload merged result to Remote
      const newManifest = {
        version: '1.0.1',
        lastSyncTime: now,
        counts: {
          annotations: annResult.activeList.length,
          inbox: inboxResult.activeList.length,
          sites: sitesResult.activeList.length
        }
      };

      await Promise.all([
        client.putFile('annotations.json', JSON.stringify(annResult.mergedList)),
        client.putFile('inbox.json', JSON.stringify(inboxResult.mergedList)),
        client.putFile('sites.json', JSON.stringify(sitesResult.mergedList)),
        client.putFile('quicknote.json', JSON.stringify(noteResult)),
        client.putFile('manifest.json', JSON.stringify(newManifest, null, 2))
      ]);

      const summaryMsg = `同步完成：划线 ${annResult.activeList.length} 条，收集箱 ${inboxResult.activeList.length} 条`;
      await this.updateStatus({
        state: 'success',
        lastSyncTime: now,
        lastMessage: summaryMsg
      });

      return {
        success: true,
        message: summaryMsg,
        stats: {
          annotations: annResult.stats,
          inbox: inboxResult.stats,
          sites: sitesResult.stats
        }
      };
    } catch (err) {
      console.error('[Sync] performSync error:', err);
      const errMsg = err.message || '同步异常，请检查网络或配置';
      await this.updateStatus({
        state: 'error',
        lastSyncTime: status.lastSyncTime || 0,
        lastMessage: `同步失败: ${errMsg}`
      });
      return { success: false, message: errMsg };
    } finally {
      isSyncingLock = false;
    }
  }
}
