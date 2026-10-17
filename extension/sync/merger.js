/**
 * Conflict-free data merger using Tombstone (Soft-delete) + Last-Write-Wins (LWW).
 * Incorporates Remotely-Save safety circuit breakers to prevent accidental data wipes.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class DataMerger {
  /**
   * Merge two lists of items based on ID and updatedAt timestamps.
   * Handles soft deletion (tombstones).
   */
  static mergeItemList(localList = [], remoteList = [], entityName = 'item') {
    const map = new Map();

    // 1. Index local items
    for (const item of localList) {
      if (!item || !item.id) continue;
      map.set(item.id, { ...item, updatedAt: item.updatedAt || item.createdAt || Date.now() });
    }

    let updatedFromRemoteCount = 0;
    let addedFromRemoteCount = 0;

    // 2. Compare with remote items
    for (const remoteItem of remoteList) {
      if (!remoteItem || !remoteItem.id) continue;
      const remoteUpdatedAt = remoteItem.updatedAt || remoteItem.createdAt || 0;

      if (!map.has(remoteItem.id)) {
        // Exists only on remote: add it
        map.set(remoteItem.id, remoteItem);
        addedFromRemoteCount++;
      } else {
        // Exists on both: Last-Write-Wins
        const localItem = map.get(remoteItem.id);
        const localUpdatedAt = localItem.updatedAt || localItem.createdAt || 0;

        if (remoteUpdatedAt > localUpdatedAt) {
          map.set(remoteItem.id, remoteItem);
          updatedFromRemoteCount++;
        }
      }
    }

    // 3. Purge expired tombstones (older than 30 days) to prevent perpetual bloat
    const now = Date.now();
    const merged = [];
    for (const item of map.values()) {
      // Only purge if it has a valid modern timestamp (> year 2001) and is older than 30 days
      const isAncientTombstone = item.isDeleted && item.updatedAt > 1000000000000 && (now - item.updatedAt > THIRTY_DAYS_MS);
      if (isAncientTombstone) {
        continue; // Drop ancient tombstones
      }
      merged.push(item);
    }

    return {
      mergedList: merged,
      activeList: merged.filter(i => !i.isDeleted), // Non-deleted list for UI display
      stats: {
        total: merged.length,
        active: merged.filter(i => !i.isDeleted).length,
        deleted: merged.filter(i => !!i.isDeleted).length,
        addedFromRemote: addedFromRemoteCount,
        updatedFromRemote: updatedFromRemoteCount
      }
    };
  }

  /**
   * Merge quick note (scratchpad)
   */
  static mergeQuickNote(localObj, remoteObj) {
    const localTime = (localObj && localObj.updatedAt) || 0;
    const remoteTime = (remoteObj && remoteObj.updatedAt) || 0;

    if (remoteTime > localTime) {
      return {
        content: remoteObj.content || '',
        updatedAt: remoteTime,
        winner: 'remote'
      };
    }
    return {
      content: (localObj && localObj.content) || '',
      updatedAt: localTime || Date.now(),
      winner: 'local'
    };
  }

  /**
   * Safety guard (Circuit Breaker): Check if incoming sync deletes > 50% of local active items
   */
  static checkMassDeletionSafety(localActiveCount, remoteActiveCount, thresholdRatio = 0.5) {
    if (localActiveCount >= 10 && remoteActiveCount < localActiveCount * (1 - thresholdRatio)) {
      return {
        safe: false,
        warning: `检测到云端大量删除变更（本地 ${localActiveCount} 条 -> 云端仅剩 ${remoteActiveCount} 条）。已触发熔断保护，暂停自动覆盖。`
      };
    }
    return { safe: true };
  }
}
