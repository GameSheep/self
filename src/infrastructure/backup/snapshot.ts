/**
 * Snapshot collection and scope reporting (P2-05).
 *
 * §10.3's last paragraph is the requirement that shapes this file: "所谓'全量'必须
 * 说明范围……未下载的远端对象只备份引用时，报告为'引用备份'，不能显示为完整离线
 * 备份". Producing the bytes is the easy half; the other half is saying honestly what
 * those bytes do and do not contain.
 *
 * Credentials are removed before anything is encrypted. Encrypting the package is
 * not a reason to ship a connection key inside it: the backup password and the OSS
 * secret are different secrets, kept by different people in different places, and
 * the vault ciphertext (`secrets[]`) is included only because it is useless
 * without the master password that never leaves the browser.
 */
import type { HubState } from '../../types';
import { stripCredentials } from '../../lib/stateBackup';

export interface SnapshotObject {
  /** Relative path inside the generation directory. */
  path: string;
  text: string;
  kind: 'data' | 'attachment';
  description: string;
}

export interface SnapshotContents {
  objects: SnapshotObject[];
  counts: Record<string, number>;
  /** Plain-language list of what was deliberately left out. */
  exclusions: string[];
  scope: {
    /** Remote documents that exist but whose body is not on this device. */
    referenceOnly: string[];
    totalBytes: number;
    /** True when the encrypted vault records are part of the package. */
    includesVaultCiphertext: boolean;
    /** True when connection secrets are inside (migration packages only). */
    includesCredentials: boolean;
    /** Exactly which secrets, in user language. Empty for ordinary backups. */
    credentialScope: string[];
  };
}

/** Collection names counted in the manifest, in the order users see them. */
const COUNTED: Array<{ key: keyof HubState; label: string }> = [
  { key: 'sites', label: '收藏' },
  { key: 'notes', label: '笔记' },
  { key: 'annotations', label: '网页批注' },
  { key: 'handwritings', label: '手绘' },
  { key: 'projects', label: '项目' },
  { key: 'servers', label: '服务器' },
  { key: 'secrets', label: '凭证' },
  { key: 'reminders', label: '提醒' },
  { key: 'checkIns', label: '签到' },
  { key: 'inbox', label: '收件箱' },
  { key: 'wucaiHighlights', label: '五彩导入' },
  { key: 'youdaoNotes', label: '有道导入' },
  { key: 'obsidianNotes', label: '远端笔记索引' }
];

/** Strip the remaining connection secrets `stripCredentials` does not know about. */
export function redactForBackup(state: HubState): HubState {
  const stripped = stripCredentials(state);
  return {
    ...stripped,
    // The Cloudflare worker key is a credential in the same sense as the OSS one.
    cloudflareSync: { ...stripped.cloudflareSync, syncKey: '' }
  };
}

export function collectSnapshot(
  state: HubState,
  options: { now?: () => number; includeCredentials?: boolean } = {}
): SnapshotContents {
  const includeCredentials = options.includeCredentials === true;
  const counts: Record<string, number> = {};
  for (const { key, label } of COUNTED) {
    const value = state[key];
    counts[label] = Array.isArray(value) ? value.length : 0;
  }

  const objects: SnapshotObject[] = [
    {
      path: 'objects/state.json',
      text: JSON.stringify(includeCredentials ? state : redactForBackup(state)),
      kind: 'data',
      description: includeCredentials ? '本机全部业务集合（含连接凭据，迁移用）' : '本机全部业务集合（已移除连接密钥）'
    }
  ];

  const attachments: SnapshotObject[] = [];
  let totalBytes = 0;
  for (const drawing of state.handwritings ?? []) {
    const dataUrl = typeof drawing.dataUrl === 'string' ? drawing.dataUrl : '';
    if (!dataUrl) continue;
    // Handwriting is stored as a PNG data URL, so it is real binary content that a
    // text-only snapshot would lose.
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    attachments.push({
      path: `attachments/handwriting-${drawing.id}.png`,
      text: dataUrl,
      kind: 'attachment',
      description: `手绘：${drawing.title}`
    });
    totalBytes += Math.floor((base64.length * 3) / 4);
  }

  const referenceOnly = (state.obsidianNotes ?? [])
    .filter((note) => !note.content)
    .map((note) => `obsidianNotes/${note.path || note.key}`);

  const credentialScope = describeCredentialScope(state);

  const exclusions = includeCredentials
    ? [
        '⚠️ 这是迁移包：它**包含**下列连接凭据，只应在迁移到另一台设备时使用，且不要放进日常备份目录。',
        ...credentialScope.map((line) => `包含：${line}`),
        '本机设备信任材料与会话仍然不含在内（从不读取，也不进入任何包）',
        '远端 OSS 文件的正文不在包内，包内只有索引与引用',
        referenceOnly.length > 0
          ? `未下载的远端文件正文：${referenceOnly.length} 个，仅登记引用`
          : '远端文件正文不在包内，包内只有索引与引用'
      ]
    : [
        '连接密钥（OSS AccessKeySecret、WebDAV 密码、AI API Key、五彩/有道令牌、Cloudflare 同步密钥）已移除，恢复后需要重新填写；非机密的标识（如 AccessKeyId、用户名）保留，方便你知道缺哪一项',
        '本机设备信任材料与会话（从不读取，也不进入备份）',
        '远端 OSS 文件的正文（只保存索引与引用，恢复后仍需联网读取）',
        referenceOnly.length > 0
          ? `未下载的远端文件正文：${referenceOnly.length} 个，仅登记引用`
          : '远端文件正文不在包内，包内只有索引与引用'
      ];

  return {
    objects: [...objects, ...attachments],
    counts,
    exclusions,
    scope: {
      referenceOnly,
      totalBytes,
      includesVaultCiphertext: (state.secrets ?? []).length > 0,
      includesCredentials: includeCredentials,
      credentialScope: includeCredentials ? credentialScope : []
    }
  };
}

/**
 * Which connection secrets a package would contain, in user language.
 *
 * The scope statement is the whole reason a migration package is allowed to exist
 * (§10.3 "需主动选择、说明范围"), so it is derived from the actual configuration
 * rather than written by hand at the call site.
 */
export function describeCredentialScope(state: HubState): string[] {
  const lines: string[] = [];
  const oss = state.obsidianConfig;
  if (oss?.accessKeySecret) {
    lines.push(`阿里云 OSS AccessKeySecret（bucket ${oss.bucket || '(未填)'}，AccessKeyId ${oss.accessKeyId || '(未填)'}）`);
  }
  const webdav = state.webdavConfig;
  if (webdav?.password) {
    lines.push(`WebDAV 密码（${webdav.url || '(未填)'}，用户 ${webdav.username || '(未填)'}）`);
  }
  if (state.aiConfig?.apiKey) {
    lines.push(`AI API Key（${state.aiConfig.provider || '(未填)'} ${state.aiConfig.model || ''}）`.trim());
  }
  if (state.wucaiConfig?.token) lines.push('五彩访问令牌');
  if (state.youdaoConfig?.token || state.youdaoConfig?.cookie) lines.push('有道令牌 / Cookie');
  if (state.cloudflareSync?.syncKey) {
    lines.push(`Cloudflare 同步密钥（${state.cloudflareSync.workerUrl || '(未填)'}）`);
  }
  return lines;
}
