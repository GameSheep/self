/**
 * Credential transfer for migration packages (P2-06).
 *
 * A migration package is the one artefact allowed to carry connection secrets
 * (§10.3). Two rules make importing them safe, and both are enforced here rather
 * than described in a comment:
 *
 * 1. **A secret is never separated from the configuration it belongs to.** §10.4.7:
 *    "不把 A 服务的凭据绑定到 B 服务". Importing therefore adopts the package's
 *    (config + secret) *pair* for a service, or nothing. There is no code path that
 *    writes the package's AccessKeySecret next to the local bucket, and none that
 *    writes it next to a different account's AccessKeyId.
 *
 * 2. **The decision is per service and reported.** Each service ends up with one of:
 *    - `adopt`        — this device has nothing configured, so the package's pair is
 *                       taken as a whole;
 *    - `keep-local`   — the same account/endpoint is already configured here; the
 *                       local pair stays (importing would be a no-op), or the local
 *                       token exists and there is no identity to compare;
 *    - `skip`         — a *different* account/service is configured here; importing
 *                       would silently re-point (or break) a working connection.
 *
 * 3. **Imported connections are marked untested.** A migrated credential has not been
 *    probed on this device, so the stored connection-test result is dropped and the
 *    settings page shows "待测试" instead of inheriting a green tick from another
 *    machine (§10.4.7 "恢复后连接凭据在本机重新绑定与测试").
 */
import type { HubState, ConnectionTestRecord } from '../../types';

export type CredentialAction = 'adopt' | 'keep-local' | 'skip';

export interface CredentialTransferPlan {
  /** v2 connection key, also the connection-test record key. */
  service: 'oss' | 'webdav' | 'ai' | 'wucai' | 'youdao' | 'sync';
  label: string;
  action: CredentialAction;
  reason: string;
}

export interface CredentialApplyResult {
  state: HubState;
  imported: string[];
  kept: string[];
  skipped: Array<{ label: string; reason: string }>;
  /** Connection-test record keys that must be cleared. */
  invalidateTests: string[];
}

function hasOssSecret(state: HubState): boolean {
  return Boolean(state.obsidianConfig?.accessKeySecret);
}

function hasWebdavSecret(state: HubState): boolean {
  return Boolean(state.webdavConfig?.password);
}

function sameIdentity(a: string, b: string): boolean {
  const normalize = (value: string) => (value || '').trim().replace(/\/+$/, '').toLowerCase();
  return normalize(a) !== '' && normalize(a) === normalize(b);
}

/** Decide, per service, what importing this package's credentials would mean. */
export function planCredentialImport(packageState: HubState, localState: HubState): CredentialTransferPlan[] {
  const plans: CredentialTransferPlan[] = [];

  const pkgOss = packageState.obsidianConfig;
  if (pkgOss?.accessKeySecret) {
    const local = localState.obsidianConfig;
    // Identity = the bucket + endpoint the secret belongs to.
    const sameAccount =
      sameIdentity(local?.bucket || '', pkgOss.bucket || '') &&
      sameIdentity(local?.endpoint || '', pkgOss.endpoint || '');
    if (!hasOssSecret(localState)) {
      plans.push({
        service: 'oss',
        label: `阿里云 OSS（${pkgOss.bucket || '未填'}）`,
        action: 'adopt',
        reason: '本机还没有保存 OSS 密钥，导入包里的整套配置与密钥。'
      });
    } else if (sameAccount && (local?.accessKeyId || '') === (pkgOss.accessKeyId || '')) {
      plans.push({
        service: 'oss',
        label: `阿里云 OSS（${pkgOss.bucket || '未填'}）`,
        action: 'keep-local',
        reason: '本机已经是同一个 OSS 账号，保留本机密钥。'
      });
    } else {
      plans.push({
        service: 'oss',
        label: `阿里云 OSS（${pkgOss.bucket || '未填'}）`,
        action: 'skip',
        reason: '本机已配置另一个 OSS 账号或地址，没有用包里的密钥覆盖它（避免把 A 账号的密钥绑到 B 账号上）。'
      });
    }
  }

  const pkgWebdav = packageState.webdavConfig;
  if (pkgWebdav?.password) {
    const local = localState.webdavConfig;
    const sameTarget = sameIdentity(local?.url || '', pkgWebdav.url || '');
    const sameUser = (local?.username || '') === (pkgWebdav.username || '');
    if (!hasWebdavSecret(localState)) {
      plans.push({
        service: 'webdav',
        label: `WebDAV（${pkgWebdav.url || '未填'}）`,
        action: 'adopt',
        reason: '本机还没有保存 WebDAV 密码，导入包里的整套配置与密码。'
      });
    } else if (sameTarget && sameUser) {
      plans.push({
        service: 'webdav',
        label: `WebDAV（${pkgWebdav.url || '未填'}）`,
        action: 'keep-local',
        reason: '本机已经是同一个 WebDAV 目标与用户，保留本机密码。'
      });
    } else {
      plans.push({
        service: 'webdav',
        label: `WebDAV（${pkgWebdav.url || '未填'}）`,
        action: 'skip',
        reason: '本机已配置另一个 WebDAV 目标或用户，没有用包里的密码覆盖它。'
      });
    }
  }

  const pkgAi = packageState.aiConfig;
  if (pkgAi?.apiKey) {
    const local = localState.aiConfig;
    const sameProvider = (local?.provider || '') === (pkgAi.provider || '');
    const sameModel = (local?.model || '') === (pkgAi.model || '');
    if (!local?.apiKey) {
      plans.push({
        service: 'ai',
        label: `AI（${pkgAi.provider || '未填'}）`,
        action: 'adopt',
        reason: '本机还没有 AI Key，导入包里的整套配置与密钥。'
      });
    } else if (sameProvider && sameModel) {
      plans.push({
        service: 'ai',
        label: `AI（${pkgAi.provider || '未填'}）`,
        action: 'keep-local',
        reason: '本机已经是同一个服务商与模型，保留本机密钥。'
      });
    } else {
      plans.push({
        service: 'ai',
        label: `AI（${pkgAi.provider || '未填'}）`,
        action: 'skip',
        reason: '本机已配置另一个 AI 服务商或模型，没有用包里的密钥覆盖它。'
      });
    }
  }

  // Tokens without an identity to compare: adopt only when the local slot is empty.
  const tokenServices: Array<{
    service: 'wucai' | 'youdao';
    label: string;
    packaged: boolean;
    localSecret: string;
  }> = [
    {
      service: 'wucai',
      label: '五彩令牌',
      packaged: Boolean(packageState.wucaiConfig?.token),
      localSecret: localState.wucaiConfig?.token || ''
    },
    {
      service: 'youdao',
      label: '有道令牌 / Cookie',
      packaged: Boolean(packageState.youdaoConfig?.token || packageState.youdaoConfig?.cookie),
      localSecret: localState.youdaoConfig?.token || localState.youdaoConfig?.cookie || ''
    }
  ];
  for (const entry of tokenServices) {
    if (!entry.packaged) continue;
    plans.push(
      entry.localSecret
        ? {
            service: entry.service,
            label: entry.label,
            action: 'keep-local',
            reason: '本机已有这个令牌，保留本机的（令牌没有可比的账号标识，覆盖没有依据）。'
          }
        : {
            service: entry.service,
            label: entry.label,
            action: 'adopt',
            reason: '本机还没有这个令牌，导入包里的。'
          }
    );
  }

  const pkgSync = packageState.cloudflareSync;
  if (pkgSync?.syncKey) {
    const local = localState.cloudflareSync;
    if (!local?.syncKey) {
      plans.push({
        service: 'sync',
        label: `Cloudflare 同步（${pkgSync.workerUrl || '未填'}）`,
        action: 'adopt',
        reason: '本机还没有同步密钥，导入包里的整套配置与密钥。'
      });
    } else if (sameIdentity(local.workerUrl || '', pkgSync.workerUrl || '')) {
      plans.push({
        service: 'sync',
        label: `Cloudflare 同步（${pkgSync.workerUrl || '未填'}）`,
        action: 'keep-local',
        reason: '本机已经是同一个同步地址，保留本机密钥。'
      });
    } else {
      plans.push({
        service: 'sync',
        label: `Cloudflare 同步（${pkgSync.workerUrl || '未填'}）`,
        action: 'skip',
        reason: '本机已配置另一个同步地址，没有用包里的密钥覆盖它。'
      });
    }
  }

  return plans;
}

export interface ApplyCredentialOptions {
  /** Services the user chose to import; defaults to every plan. */
  acceptedServices?: string[];
}

/**
 * Adopt the package's credential pairs that the plan marked `adopt`.
 *
 * Everything else is left exactly as it is: this function only ever *adds* a
 * credential to a service that had none.
 */
export function applyCredentialImport(
  packageState: HubState,
  localState: HubState,
  plans: CredentialTransferPlan[],
  options: ApplyCredentialOptions = {}
): CredentialApplyResult {
  const accepted = options.acceptedServices ? new Set(options.acceptedServices) : undefined;
  const state: HubState = { ...localState };
  const imported: string[] = [];
  const kept: string[] = [];
  const skipped: Array<{ label: string; reason: string }> = [];
  const invalidateTests: string[] = [];

  for (const plan of plans) {
    if (accepted && !accepted.has(plan.service)) {
      skipped.push({ label: plan.label, reason: '这次没有选择导入它的凭据。' });
      continue;
    }
    if (plan.action !== 'adopt') {
      if (plan.action === 'keep-local') kept.push(plan.label);
      else skipped.push({ label: plan.label, reason: plan.reason });
      continue;
    }

    // Adopting always takes the whole pair (config + secret) from the package.
    switch (plan.service) {
      case 'oss':
        state.obsidianConfig = { ...packageState.obsidianConfig };
        break;
      case 'webdav':
        state.webdavConfig = { ...packageState.webdavConfig };
        break;
      case 'ai':
        state.aiConfig = { ...packageState.aiConfig };
        break;
      case 'wucai':
        state.wucaiConfig = {
          enabled: Boolean(packageState.wucaiConfig?.enabled),
          token: packageState.wucaiConfig?.token || '',
          lastSyncTime: packageState.wucaiConfig?.lastSyncTime
        };
        break;
      case 'youdao':
        state.youdaoConfig = {
          enabled: Boolean(packageState.youdaoConfig?.enabled),
          token: packageState.youdaoConfig?.token || '',
          cookie: packageState.youdaoConfig?.cookie,
          lastSyncTime: packageState.youdaoConfig?.lastSyncTime
        };
        break;
      case 'sync':
        state.cloudflareSync = { ...packageState.cloudflareSync };
        break;
    }
    imported.push(plan.label);
    invalidateTests.push(plan.service);
  }

  if (invalidateTests.length > 0) {
    // A credential that arrived from another device has not been probed here.
    const tests: Record<string, ConnectionTestRecord> = { ...(localState.connectionTests || {}) };
    for (const service of invalidateTests) delete tests[service];
    state.connectionTests = tests;
  }

  return { state, imported, kept, skipped, invalidateTests };
}
