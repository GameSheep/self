/**
 * Backup target resolution (P1-09).
 * The bug this file exists to kill: the manual "立即备份" button resolved its
 * destination inside `useCloudBackup`, and the *automatic* trigger had a second,
 * · different condition hard-coded into an effect. The effect only looked at the
 */
import type { HubState, ObsidianConfig, WebdavSyncConfig } from '../types';
import { hasRealOssKeys } from './s3Client';
import { readStorageMode, type StorageMode } from './storageMode';

export type BackupProvider = 'oss' | 'webdav' | 'none';

/**
 * Which on-disk format the automatic snapshot task writes.
 *
 * §10.2: "旧 `state.json` 保留只读，升级新格式由用户明确启用". So `legacy` stays the
 * default for existing *and* new profiles: switching the format silently would
 * change what a working backup contains, and the v3 format additionally needs a
 * backup password the user has to establish first.
 */
export type BackupFormat = 'legacy' | 'v3';

export interface BackupPolicy {
  /**
   * `auto` keeps the historical preference order (WebDAV first when both are
   * configured). `oss` / `webdav` pin the choice so a second configuration can
   * never quietly take over the writes.
   */
  provider: 'auto' | 'oss' | 'webdav';
  /**
   * Every destination that should receive a copy.
   *
   * The user asked for multi-target backups ("WebDAV 备一份，OSS 也备一份"). When this is set,
   * each listed provider that is fully configured gets its own upload; `provider` above stays
   * as the fallback for older payloads and for the "实际使用的提供方" line in the settings.
   */
  destinations?: Array<'oss' | 'webdav'>;
  /**
   * Whether the automatic snapshot task runs. Filling in connection fields must
   * never flip this: the old code derived "enabled" from field presence.
   */
  enabled: boolean;
  /** v3 is opt-in; see `BackupFormat`. */
  format: BackupFormat;
}

export interface BackupTarget {
  provider: BackupProvider;
  /** True when the selected provider has every field it needs. */
  configured: boolean;
  /** True when the snapshot task is switched on. */
  enabled: boolean;
  /** configured && enabled — the only case where a run is legitimate. */
  canRun: boolean;
  /** Which format that run writes. */
  format: BackupFormat;
  /** Safe, human-readable destination. Never contains a secret. */
  destination: string;
  /** Why a run cannot happen, in user language. Empty when `canRun`. */
  reason?: string;
  /** Both providers are fully configured: the user must be told which one wins. */
  bothConfigured: boolean;
  ossConfigured: boolean;
  webdavConfigured: boolean;
  /**
   * Set when the chosen format cannot contain this device's data.
   *
   * The case this exists for: storage mode is `v3` (business data lives in the library,
   * the payload holds only device configuration) but the backup format is still `legacy`,
   * which writes that payload. The backup succeeds and contains no notes, bookmarks or
   * credentials-vault entries — the kind of "it worked" that is discovered when restoring.
   */
  formatWarning?: string;
}

export function webdavConfigured(config?: WebdavSyncConfig): boolean {
  return Boolean(config && config.enabled && config.url && config.username && config.password);
}

export function ossConfigured(config?: ObsidianConfig): boolean {
  return Boolean(config && config.enabled && config.bucket && hasRealOssKeys(config));
}

/** Destination preview shared by the settings UI and the status line. */
export function describeOssDestination(config: ObsidianConfig): string {
  const prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '');
  const base = `${config.bucket}.${config.endpoint || 'oss'}`;
  return prefix ? `${base}/${prefix}/.selfhub/state.json` : `${base}/.selfhub/state.json`;
}

export function describeWebdavDestination(config: WebdavSyncConfig): string {
  const url = (config.url || '').replace(/\/+$/, '');
  const prefix = (config.pathPrefix || '').replace(/^\/+|\/+$/g, '');
  if (!url) return '';
  return `${url}/${prefix ? `${prefix}/` : ''}state.json`;
}

/**
 * Single source of truth for "where does the whole-state backup go".
 * Reads the policy out of the state so manual and automatic callers cannot
 * diverge. An absent policy behaves exactly like the pre-P1 build (WebDAV
 * · preferred, auto-run whenever a target is configured) so upgrading does not
 */
export function resolveBackupTarget(
  state: HubState,
  options: { storageMode?: StorageMode } = {}
): BackupTarget {
  const storageMode = options.storageMode ?? readStorageMode();
  const oss = state.obsidianConfig;
  const webdav = state.webdavConfig;
  const ossOk = ossConfigured(oss);
  const webdavOk = webdavConfigured(webdav);
  const policy: BackupPolicy = state.backupPolicy ?? { provider: 'auto', enabled: ossOk || webdavOk, format: 'legacy' };

  let provider: BackupProvider = 'none';
  if (policy.provider === 'oss') {
    provider = ossOk ? 'oss' : 'none';
  } else if (policy.provider === 'webdav') {
    provider = webdavOk ? 'webdav' : 'none';
  } else if (webdavOk) {
    provider = 'webdav';
  } else if (ossOk) {
    provider = 'oss';
  }

  const configured = provider !== 'none';
  const destination = provider === 'oss' ? describeOssDestination(oss) : provider === 'webdav' ? describeWebdavDestination(webdav!) : '';
  const format = policy.format ?? 'legacy';

  /**
   * v3 storage + legacy format = a backup that cannot contain the user's data.
   *
   * Automatic runs are stopped (a silent data-less backup is worse than none), manual runs
   * are still allowed because the user may genuinely want the device configuration — but the
   * UI shows this text next to the button either way.
   */
  const formatWarning =
    storageMode === 'v3' && format === 'legacy'
      ? '当前存储模式是 v3：资料在 v3 库里，而旧格式备份写的是本机负载——它只包含连接与偏好，不含笔记、收藏或金库条目。请改用「v3 加密备份」，或先切回 v2 负载再备份。'
      : undefined;

  let reason: string | undefined;
  if (!configured) {
    const pinned = policy.provider !== 'auto';
    reason = pinned
      ? `已指定用 ${policy.provider === 'oss' ? 'OSS' : 'WebDAV'} 备份，但连接信息还不完整。`
      : '还没有可用的备份目的地：填写 OSS 或 WebDAV 连接并保存。';
  } else if (!policy.enabled) {
    reason = '连接已保存，但自动备份尚未启用。';
  } else if (formatWarning) {
    // Configured and switched on, but this run would write something incomplete: the reason
    // has to say that, because "canRun: false" alone is invisible.
    reason = formatWarning;
  }

  return {
    provider,
    configured,
    enabled: policy.enabled,
    canRun: configured && policy.enabled && !formatWarning,
    format,
    destination,
    reason,
    bothConfigured: ossOk && webdavOk,
    ossConfigured: ossOk,
    webdavConfigured: webdavOk,
    formatWarning
  };
}

/**
 * Every destination a backup should reach (multi-target).
 *
 * `destinations` is authoritative when present: each listed provider that is fully configured
 * gets a target of its own, so "WebDAV + OSS" is two uploads rather than one provider winning.
 * Without it the behaviour is exactly the old single-target one.
 */
export function resolveBackupTargets(
  state: HubState,
  options: { storageMode?: StorageMode } = {}
): BackupTarget[] {
  const single = resolveBackupTarget(state, options);
  const policy = state.backupPolicy;
  const selected = policy?.destinations?.length ? policy.destinations : null;
  if (!selected) return single.provider === 'none' ? [] : [single];

  const ossOk = single.ossConfigured;
  const webdavOk = single.webdavConfigured;
  return selected
    .filter((provider) => (provider === 'oss' ? ossOk : webdavOk))
    .map((provider) => {
      if (provider === single.provider) return single;
      // `single.destination`/`reason` describe *single's* provider; copying them
      // onto the other provider labelled the OSS run with the WebDAV path (and
      // vice versa) in the settings status line.
      return {
        ...single,
        provider,
        destination:
          provider === 'oss'
            ? describeOssDestination(state.obsidianConfig)
            : describeWebdavDestination(state.webdavConfig)
      };
    });
}

/**
 * Normalise a persisted policy.
 *
 * `enabled` falls back to "a target is configured" so an existing user's working
 * backup is preserved; a brand-new profile with no connection stays off.
 */
export function normalizeBackupPolicy(
  raw: unknown,
  oss: ObsidianConfig,
  webdav: WebdavSyncConfig
): BackupPolicy {
  const base = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const provider = base.provider === 'oss' || base.provider === 'webdav' || base.provider === 'auto' ? base.provider : 'auto';
  const hasTarget = ossConfigured(oss) || webdavConfigured(webdav);
  const enabled = typeof base.enabled === 'boolean' ? base.enabled : hasTarget;
  // An unrecognised or absent format means "keep writing what you were writing".
  const format: BackupFormat = base.format === 'v3' ? 'v3' : 'legacy';
  /**
   * Multi-target list. Kept only when it names real providers; `undefined` (not `[]`) is what
   * "fall back to the single provider" means, so an empty array must not be persisted as such.
   */
  const destinations = Array.isArray(base.destinations)
    ? (base.destinations.filter((entry) => entry === 'oss' || entry === 'webdav') as Array<'oss' | 'webdav'>)
    : undefined;
  return {
    provider,
    enabled,
    format,
    ...(destinations && destinations.length > 0 ? { destinations } : {})
  };
}
