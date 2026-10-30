/**
 * Connection state vocabulary (P1-08).
 *
 * The defect this file exists to kill: the old settings panel had exactly one
 * judgement — `def.isConfigured(state)` — and it was rendered as a green dot
 * labelled 「已配置」. One flag stood in for four unrelated facts:
 *
 *   1. are the required fields filled?
 *   2. has *this exact configuration version* ever been probed successfully?
 *   3. has the user switched a purpose on for this connection?
 *   4. is a background task actually running with it?
 *
 * They are now four separate answers. Filling a URL can never make 2 true,
 * a passed test can never make 3 or 4 true, and editing the URL after a test
 * invalidates 2 instead of inheriting a stale green tick.
 *
 * A test record is bound to the probed configuration by a *fingerprint*, so
 * "verified" always means "this version of the connection was probed", not
 * "the connection uses the same id as something that once worked".
 */
import type { HubState, ObsidianConfig, AiConfig, ConnectionTestRecord } from '../types';
import type { IntegrationDef, IntegrationField } from './integrations';
import { hasRealOssKeys, testOssConnection } from './s3Client';
import { testWebdav } from './webdavClient';
import { testAiProvider } from './aiProviders';
import { resolveBackupTarget } from './backupPolicy';
import { isExtensionContext } from './extensionBridge';

/** Mirrors `StatusTone` in src/shared/ui without pulling React into this module. */
export type ConnectionTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

export type ConnectionStage = 'empty' | 'draft' | 'saved-untested' | 'verified' | 'failed' | 'stale';

export interface ConnectionStatus {
  stage: ConnectionStage;
  label: string;
  tone: ConnectionTone;
  detail?: string;
}

/** One row of the four-fact breakdown shown on every connection card. */
export interface ConnectionFact {
  key: 'fields' | 'test' | 'purpose' | 'task';
  label: string;
  value: string;
  tone: ConnectionTone;
  detail?: string;
}

/* -------------------------------------------------------------------------- */
/* Field completeness                                                         */
/* -------------------------------------------------------------------------- */

export function requiredFields(def: IntegrationDef): IntegrationField[] {
  return def.fields.filter((f) => f.required === true);
}

export function missingRequiredFields(def: IntegrationDef, values: Record<string, string>): IntegrationField[] {
  return requiredFields(def).filter((f) => !(values[f.key] ?? '').trim());
}

/**
 * "The fields a working connection needs are present." Deliberately says nothing
 * about enable switches, tests or tasks.
 */
export function requiredFieldsComplete(def: IntegrationDef, values: Record<string, string>): boolean {
  return missingRequiredFields(def, values).length === 0;
}

/* -------------------------------------------------------------------------- */
/* Fingerprint                                                                */
/* -------------------------------------------------------------------------- */

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Math.imul keeps the multiply in 32-bit range (a plain * overflows to float).
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function djb2_32(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(hash, 33) + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function toHex8(n: number): string {
  return n.toString(16).padStart(8, '0');
}

/**
 * Stable, **non-reversible** hash of a connection's parameters (FNV-1a + djb2).
 *
 * It is an invalidation fingerprint, NOT a security primitive: it only has to
 * answer "is this the same configuration that was probed?" and it must never be
 * usable to recover a key. It is not a checksum for integrity either — a
 * 32+32-bit digest is far too weak for that, and that is fine.
 *
 * Only the declared connection parameters participate (the non-toggle fields).
 * Enable/purpose switches are excluded on purpose: flipping "启用连接" does not
 * change what a probe proved, so it must not invalidate a test result.
 *
 * The digest — not the values — is what gets persisted and rendered. Secret
 * values never reach a log, a DOM attribute or the test record.
 */
export function fingerprintOf(def: IntegrationDef, values: Record<string, string>): string {
  const keys = def.fields.filter((f) => f.type !== 'toggle').map((f) => f.key);
  const canonical = keys.map((key) => `${key}=${values[key] ?? ''}`).join('\u0001');
  const input = `${def.id}\u0000${canonical}`;
  return `${toHex8(fnv1a32(input))}${toHex8(djb2_32(input))}`;
}

/** Keys whose *draft* value differs from what is persisted right now. */
export function changedKeys(
  def: IntegrationDef,
  values: Record<string, string>,
  persisted: Record<string, string>
): string[] {
  const keys = new Set([...Object.keys(persisted), ...Object.keys(values)]);
  return Array.from(keys).filter((key) => (values[key] ?? '') !== (persisted[key] ?? ''));
}

/* -------------------------------------------------------------------------- */
/* Test records                                                               */
/* -------------------------------------------------------------------------- */

export function testRecordFor(state: HubState, def: IntegrationDef): ConnectionTestRecord | undefined {
  return state.connectionTests?.[def.id];
}

function formatAt(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return String(at);
  }
}

export function capabilityLabel(capability: string): string {
  const labels: Record<string, string> = {
    listFiles: '可列出文件',
    readFile: '可读取文件',
    writeFile: '可写入文件',
    snapshotBackup: '可写入全量备份',
    cloudIngest: '可调用云端模型',
    list: '可列出对象',
    read: '可读取',
    invoke: '可完成一次模型调用'
  };
  return labels[capability] ?? capability;
}

/** '检测结果已过期，配置已修改' is shown whenever a record no longer matches. */
export const STALE_TEST_TEXT = '检测结果已过期，配置已修改';

function testFact(
  state: HubState,
  def: IntegrationDef,
  persisted: Record<string, string>,
  draft: Record<string, string> | undefined
): { value: string; tone: ConnectionTone; detail?: string } {
  const record = testRecordFor(state, def);
  if (!record) {
    return { value: '从未检测', tone: 'neutral', detail: '没有任何检测记录；保存连接后可以点「测试连接」验证。' };
  }
  const result = `${record.ok ? '检测通过' : '检测失败'} · ${formatAt(record.at)}`;
  const proven = record.capabilities?.length
    ? `（${record.capabilities.map(capabilityLabel).join('、')}）`
    : '';
  // The record is compared against what is on screen (the live draft when there
  // is one). Editing the address, key or path must make the result stale
  // *immediately* — waiting for a save would leave a green tick next to a
  // connection that is no longer the one that was probed.
  const live = draft ?? persisted;
  const liveFp = fingerprintOf(def, live);
  const unsaved = draft ? changedKeys(def, draft, persisted).length > 0 : false;

  if (record.fingerprint === liveFp) {
    return {
      value: `${result}${proven}`,
      tone: record.ok ? 'ok' : 'danger',
      detail: unsaved
        ? '这是针对当前草稿的检测结果，保存后才会成为已保存配置的检测结果。'
        : record.message
    };
  }
  return {
    value: `${STALE_TEST_TEXT}（上次检测：${result}）`,
    tone: 'warn',
    detail: '当前配置与上次检测时不是同一版本，请重新检测；旧结果不代表当前连接可用。'
  };
}

/* -------------------------------------------------------------------------- */
/* Purposes and tasks                                                         */
/* -------------------------------------------------------------------------- */

export function purposeLabel(purpose: string): string {
  const labels: Record<string, string> = {
    backup: '整站备份',
    'remote-vault': '远端笔记库',
    'source-import': '内容导入',
    'cloud-ai': '云端 AI',
    'note-source': '笔记来源'
  };
  return labels[purpose] ?? purpose;
}

export interface PurposeStatus {
  enabled: boolean;
  label: string;
  tone: ConnectionTone;
  detail: string;
}

/**
 * Purpose enablement is its own record (`state.purposes`), never inferred from
 * whether a field happens to be filled or from a legacy `enabled` flag.
 */
export function purposeStatus(
  state: HubState,
  purpose: string,
  options: { supported?: boolean; connection?: string } = {}
): PurposeStatus {
  const name = purposeLabel(purpose);
  if (options.supported === false) {
    return {
      enabled: false,
      label: '当前不支持',
      tone: 'warn',
      detail: `${options.connection || '该连接'}还没有接通「${name}」需要的接口，所以没有可绑定的用途。`
    };
  }
  const enabled = state.purposes?.[purpose] === true;
  return {
    enabled,
    label: enabled ? '用途已启用' : '用途未启用',
    tone: enabled ? 'ok' : 'neutral',
    detail: enabled
      ? `已把该连接绑定到「${name}」。`
      : `尚未把该连接绑定到「${name}」；填写字段不会自动绑定用途。`
  };
}

function providerLabel(provider: 'oss' | 'webdav' | 'none'): string {
  if (provider === 'oss') return '阿里云 OSS';
  if (provider === 'webdav') return 'WebDAV';
  return '未确定';
}

/**
 * "Is a background task running with this connection?" — read from the actual
 * task configuration, not from field presence.
 */
export function taskStatus(
  state: HubState,
  def: IntegrationDef
): { running: boolean; label: string; tone: ConnectionTone; detail: string } {
  if (def.purpose === 'backup') {
    const target = resolveBackupTarget(state);
    if (!target.configured) {
      return {
        running: false,
        label: '没有可运行的任务',
        tone: 'neutral',
        detail: target.reason || '还没有可用的备份目的地。'
      };
    }
    if (!target.enabled) {
      return {
        running: false,
        label: '自动备份未开启',
        tone: 'neutral',
        detail: `目的地已就绪（${providerLabel(target.provider)}），但自动备份任务没有开启。`
      };
    }
    return {
      running: true,
      label: '自动备份已开启',
      tone: 'ok',
      detail: `写入 ${target.destination}；普通网页只在页面打开时运行，扩展里还能随浏览器后台运行，浏览器关闭后都停止。`
    };
  }

  if (def.purpose === 'cloud-ai') {
    const allowed = state.aiConfig?.cloudAiEnabled === true;
    return {
      running: allowed,
      label: allowed ? '云端 AI 已允许' : '仅在主动操作时使用',
      tone: allowed ? 'warn' : 'neutral',
      detail: allowed
        ? '你主动发起分拣/提炼时才会调用云端；没有后台任务会自动发送内容。'
        : '默认只用本机规则，任何内容都不会发到云端。'
    };
  }

  if (def.purpose === 'remote-vault' && resolveBackupTarget(state).provider === 'oss' && resolveBackupTarget(state).canRun) {
    return {
      running: true,
      label: '同时用作备份目的地',
      tone: 'ok',
      detail: '该连接当前也是整站备份的目的地（见「数据与备份」）。'
    };
  }

  return {
    running: false,
    label: '没有后台任务',
    tone: 'neutral',
    detail: '该连接只在你主动打开对应页面时使用，没有定时任务。'
  };
}

/* -------------------------------------------------------------------------- */
/* Combined status                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The single badge on a connection card. `draft` is the live form content when
 * the user has unsaved edits; omit it to describe the saved configuration.
 */
export function connectionStatus(
  state: HubState,
  def: IntegrationDef,
  draft?: Record<string, string>
): ConnectionStatus {
  const persisted = def.read(state);
  const values = draft ?? persisted;
  const missing = missingRequiredFields(def, values);

  if (missing.length) {
    return {
      stage: 'empty',
      label: '未填写完整',
      tone: 'neutral',
      detail: `还缺：${missing.map((f) => f.label).join('、')}`
    };
  }

  const dirty = draft ? changedKeys(def, values, persisted).length > 0 : false;
  const record = testRecordFor(state, def);
  const liveFp = fingerprintOf(def, values);
  // Stale is judged against the live values: an edit invalidates the result even
  // before it is saved.
  const stale = Boolean(record && record.fingerprint !== liveFp);

  if (dirty) {
    const draftTested = Boolean(record && record.fingerprint === liveFp);
    const notes: string[] = [];
    if (stale) notes.push(`${STALE_TEST_TEXT}。`);
    if (draftTested) notes.push(`当前草稿已在本机检测${record!.ok ? '通过' : '失败'}，保存后即成为该配置的检测结果。`);
    return {
      stage: 'draft',
      label: '草稿未保存',
      tone: 'warn',
      detail: notes.join('') || '当前内容还没有保存；测试连接只针对草稿，不会写入。'
    };
  }

  if (!record) {
    return {
      stage: 'saved-untested',
      label: '已保存，尚未测试',
      tone: 'info',
      detail: '连接信息已保存，但没有检测记录——「已保存」不代表可用。'
    };
  }

  if (stale) {
    return {
      stage: 'stale',
      label: STALE_TEST_TEXT,
      tone: 'warn',
      detail: `上次检测是针对另一个版本的配置（${formatAt(record.at)}），修改地址、密钥或路径后必须重新检测。`
    };
  }

  return record.ok
    ? {
        stage: 'verified',
        label: '检测通过',
        tone: 'ok',
        detail: `${formatAt(record.at)} · ${record.message}`
      }
    : {
        stage: 'failed',
        label: '检测失败',
        tone: 'danger',
        detail: `${formatAt(record.at)} · ${record.message}`
      };
}

/** The four facts, kept separate all the way to the DOM. */
export function connectionFacts(
  state: HubState,
  def: IntegrationDef,
  draft?: Record<string, string>
): ConnectionFact[] {
  const persisted = def.read(state);
  const values = draft ?? persisted;
  const missing = missingRequiredFields(def, values);
  const purpose = purposeStatus(state, def.purpose, {
    supported: def.capabilities.length > 0,
    connection: def.title
  });
  const task = taskStatus(state, def);
  const test = testFact(state, def, persisted, draft);

  return [
    {
      key: 'fields',
      label: '字段是否完整',
      value: missing.length ? `还缺 ${missing.map((f) => f.label).join('、')}` : '必填字段已填写',
      tone: missing.length ? 'warn' : 'ok',
      detail: '只看字段是否填写，不代表已启用、已测试或任务在运行。'
    },
    {
      key: 'test',
      label: '最近检测结果',
      value: test.value,
      tone: test.tone,
      detail: test.detail
    },
    {
      key: 'purpose',
      label: `用途（${purposeLabel(def.purpose)}）`,
      value: purpose.label,
      tone: purpose.tone,
      detail: purpose.detail
    },
    {
      key: 'task',
      label: '任务是否在运行',
      value: task.label,
      tone: task.tone,
      detail: task.detail
    }
  ];
}

/* -------------------------------------------------------------------------- */
/* Running a probe                                                            */
/* -------------------------------------------------------------------------- */

export interface ConnectionTestResult {
  /**
   * `unavailable` means the probe is not applicable — missing fields, demo keys,
   * or a connection type with no probe at all. It must be reported as "cannot
   * test here", never dressed up as a failure of the credentials.
   */
  status: 'ok' | 'failed' | 'unavailable';
  message: string;
  /** Only what the probe actually proved. Empty when it proved nothing. */
  capabilities: string[];
}

function provenSentence(def: IntegrationDef): string {
  const proven = def.testCapabilities.map(capabilityLabel).join('、');
  return proven ? `已验证：${proven}。` : '已验证：探测请求得到了成功响应。';
}

/**
 * Probe the **draft** values. Never writes anything: recording the result is the
 * caller's job (`onRecordConnectionTest`), and saving is the user's.
 */
export async function runConnectionTest(
  def: IntegrationDef,
  values: Record<string, string>
): Promise<ConnectionTestResult> {
  const missing = missingRequiredFields(def, values);
  if (missing.length) {
    return {
      status: 'unavailable',
      message: `无法检测：请先填写 ${missing.map((f) => f.label).join('、')}。`,
      capabilities: []
    };
  }

  if (def.id === 'oss') {
    const config: ObsidianConfig = {
      enabled: true,
      bucket: values.bucket || '',
      endpoint: values.endpoint || '',
      region: values.endpoint || '',
      accessKeyId: values.accessKeyId || '',
      accessKeySecret: values.accessKeySecret || '',
      prefix: values.prefix || ''
    };
    if (!hasRealOssKeys(config)) {
      return {
        status: 'unavailable',
        message:
          '无法在当前环境验证：OSS 需要真实的 AccessKey ID 与 Secret。当前是占位/演示值，探测不会产生任何证据，也不会显示成功。',
        capabilities: []
      };
    }
    const result = await testOssConnection(config);
    return result.success
      ? {
          status: 'ok',
          message: `${result.message}\n${provenSentence(def)}本次未验证写入权限。`,
          capabilities: [...def.testCapabilities]
        }
      : { status: 'failed', message: result.message, capabilities: [] };
  }

  if (def.id === 'webdav') {
    const result = await testWebdav({
      enabled: true,
      url: values.url || '',
      username: values.username || '',
      password: values.password || '',
      pathPrefix: values.pathPrefix || 'selfhub_sync'
    });
    if (result.ok) {
      return {
        status: 'ok',
        message: `${result.message}\n${provenSentence(def)}本次未验证写入权限。`,
        capabilities: [...def.testCapabilities]
      };
    }
    const environmentNote = !isExtensionContext() && /无法连接|超时|未完成/.test(result.message)
      ? '\n（当前是普通网页：该服务器可能没有放行跨域，需在浏览器扩展环境中重试。这不等于凭据错误。）'
      : '';
    return { status: 'failed', message: `${result.message}${environmentNote}`, capabilities: [] };
  }

  if (def.id === 'ai') {
    const config: AiConfig = {
      provider: (values.provider as AiConfig['provider']) || 'gemini',
      apiKey: values.apiKey || '',
      baseUrl: values.baseUrl || '',
      model: values.model || '',
      cloudAiEnabled: values.cloudAiEnabled === 'true'
    };
    const result = await testAiProvider(config);
    const substituted = result.modelSubstituted
      ? `\n注意：模型名与服务商不匹配，已自动改用 ${result.model}。请把模型字段也改成它，避免再次产生 400。`
      : '';
    return result.ok
      ? {
          status: 'ok',
          message: `${result.message}\n${provenSentence(def)}${substituted}`,
          capabilities: [...def.testCapabilities]
        }
      : { status: 'failed', message: `${result.message}${substituted}`, capabilities: [] };
  }

  return {
    status: 'unavailable',
    message: `${def.title} 目前不提供连接检测：本版本还没有接通它的拉取接口，无法证明远端可用。`,
    capabilities: []
  };
}
