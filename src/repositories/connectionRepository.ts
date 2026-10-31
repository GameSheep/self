/**
 * Connection, credential and purpose storage (P2-03).
 * Everything here follows from one sentence in §8.2: "不要把三套状态压进一个
 * `configured: boolean`". A connection therefore carries four *separate* facts,
 * · 4. a task is running      → job state (P2-05); here only its *readiness*
 */
import type { Connection, ConnectionCredential, PurposeBinding, PurposeId } from '../domain/model';
import { runV3Transaction, requestToPromise } from '../infrastructure/storage/idbV3';
import { validateRecord } from './schema';
import { NotFoundError, appError, fail, ok, toAppError, type Result } from './errors';
import { encryptText, decryptText } from '../lib/crypto';

const CONNECTIONS = 'connections_v3';
const CREDENTIALS = 'connection_credentials_v3';
const BINDINGS = 'bindings_v3';
const ITEMS = 'items_v3';
const JOBS = 'jobs_v3';

/** Hash of the public config, used to detect "something changed" without secrets. */
export function fingerprintConfig(provider: string, publicConfig: Record<string, string>): string {
  const pairs = Object.keys(publicConfig)
    .sort()
    .map((key) => `${key}=${publicConfig[key] ?? ''}`)
    .join('|');
  const input = `${provider}|${pairs}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export type ConnectionStage = 'empty' | 'saved-untested' | 'verified' | 'failed' | 'stale';

export interface ConnectionStatus {
  stage: ConnectionStage;
  label: string;
  tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'info';
  detail?: string;
}

/** Fields each provider needs before it can be considered "filled in". */
const REQUIRED_PUBLIC_FIELDS: Record<string, string[]> = {
  oss: ['bucket', 'endpoint'],
  webdav: ['url', 'username'],
  ai: ['provider', 'model'],
  wucai: [],
  youdao: [],
  'cloudflare-sync': ['workerUrl']
};

export function requiredFieldsFor(provider: string): string[] {
  return REQUIRED_PUBLIC_FIELDS[provider] ?? [];
}

export function requiredFieldsComplete(provider: string, publicConfig: Record<string, string>): boolean {
  const required = requiredFieldsFor(provider);
  if (required.length === 0) return true;
  return required.every((field) => Boolean((publicConfig[field] || '').trim()));
}

/**
 * The connection's own status — about *the connection*, not about any task.
 *
 * A `stale` result is the important one: it means a test passed for an older
 * configuration, so the green result must not be shown for the current one.
 */
export function connectionStatus(connection: Connection): ConnectionStatus {
  if (!requiredFieldsComplete(connection.provider, connection.publicConfig)) {
    return { stage: 'empty', label: '未填写完整', tone: 'neutral', detail: '还有必填字段没填。' };
  }
  const verification = connection.verification;
  if (!verification) {
    return { stage: 'saved-untested', label: '已保存待测试', tone: 'info', detail: '还没有测试过这个连接。' };
  }
  if (verification.configVersion !== undefined && verification.configVersion !== connection.configVersion) {
    return {
      stage: 'stale',
      label: '检测结果已过期',
      tone: 'warn',
      detail: '配置在检测之后改动过，请重新测试。'
    };
  }
  return verification.ok
    ? { stage: 'verified', label: '检测通过', tone: 'ok', detail: verification.message }
    : { stage: 'failed', label: '检测失败', tone: 'danger', detail: verification.message };
}

export type TaskReadiness =
  | 'runnable'
  | 'waiting-unlock'
  | 'blocked-missing-credential'
  | 'blocked-unsupported-env'
  | 'paused';

export interface ReadinessInput {
  connection: Connection;
  binding?: PurposeBinding;
  hasCredential: boolean;
  vaultUnlocked: boolean;
  /** Capabilities the environment can actually provide for this purpose. */
  supportedInEnvironment: boolean;
}

/**
 * What would happen if this binding tried to run *now*.
 *
 * `waiting-unlock` is a distinct state, not a failure: §10.2 says a locked
 * credential store must park the task rather than report success or hammer the
 * network. Callers use this to decide whether to queue, skip or prompt.
 */
export function evaluateReadiness(input: ReadinessInput): TaskReadiness {
  const { connection, binding, hasCredential, vaultUnlocked, supportedInEnvironment } = input;
  if (!supportedInEnvironment) return 'blocked-unsupported-env';
  if (!requiredFieldsComplete(connection.provider, connection.publicConfig)) return 'blocked-missing-credential';
  if (!binding || !binding.enabled) return 'paused';
  if (binding.configVersion !== connection.configVersion) {
    // The binding was made against a different configuration; running it would
    // use credentials the user never approved for this target.
    return 'paused';
  }
  if (hasCredential && !vaultUnlocked) return 'waiting-unlock';
  if (!hasCredential && connection.credentialRef) return 'blocked-missing-credential';
  return 'runnable';
}

export interface SaveConnectionInput {
  id?: string;
  provider: string;
  displayName?: string;
  publicConfig: Record<string, string>;
  /**
   * Purposes to *bind*. Bindings are created disabled; enabling is a separate,
   * explicit call (`setPurposeEnabled`).
   */
  purposes?: PurposeId[];
}

export interface SaveConnectionOutput {
  connection: Connection;
  /** True when the configuration changed, which invalidates the old test result. */
  versionBumped: boolean;
}

export interface AffectedPurpose {
  purpose: PurposeId;
  bindingId: string;
  enabled: boolean;
}

export interface DeleteConnectionPreview {
  connection: Connection;
  affectedPurposes: AffectedPurpose[];
  /** Items/projects that reference the connection indirectly, for the message. */
  referencingProjects: number;
  /** Always false: this module never touches remote business data. */
  deletesRemoteData: false;
}

export interface DeleteConnectionResult {
  deleted: boolean;
  /** Purposes that were disabled as part of the delete. */
  disabledPurposes: AffectedPurpose[];
}

export interface ConnectionRepositoryOptions {
  libraryId: string;
  now?: () => number;
  newId?: (prefix: string) => string;
}

export class ConnectionRepository {
  private readonly libraryId: string;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;

  constructor(options: ConnectionRepositoryOptions) {
    this.libraryId = options.libraryId;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? ((prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  }

  private assertValid(store: string, value: unknown): void {
    const issues = validateRecord(store, value);
    if (issues.length > 0) {
      throw new Error(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
    }
  }

  async listConnections(): Promise<Result<Connection[]>> {
    try {
      const rows = await runV3Transaction([CONNECTIONS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(CONNECTIONS).getAll() as IDBRequest<Connection[]>)
      );
      return ok(rows.value.filter((row) => row.libraryId === this.libraryId));
    } catch (err) {
      return fail(toAppError(err, '无法读取连接列表'));
    }
  }

  async getConnection(id: string): Promise<Result<Connection | undefined>> {
    try {
      const row = await runV3Transaction([CONNECTIONS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(CONNECTIONS).get([this.libraryId, id]))
      );
      return ok((row.value as Connection | undefined) ?? undefined);
    } catch (err) {
      return fail(toAppError(err, '无法读取连接'));
    }
  }

  /**
   * Create or update a connection.
   *
   * Deliberately does **not** accept a secret: secrets go through
   * `saveCredential`, which requires an unlocked master password. Splitting them
   * means a half-filled form can be saved without ever holding plaintext.
   */
  async saveConnection(input: SaveConnectionInput): Promise<Result<SaveConnectionOutput>> {
    const provider = (input.provider || '').trim();
    if (!provider) {
      return fail(appError('VALIDATION', '缺少服务商标识。', { safeDetail: 'empty provider' }));
    }
    try {
      const result = await runV3Transaction([CONNECTIONS, BINDINGS], 'readwrite', async (ctx) => {
        const store = ctx.store(CONNECTIONS);
        const existing = input.id
          ? ((await requestToPromise(store.get([this.libraryId, input.id]))) as Connection | undefined)
          : undefined;

        const publicConfig = { ...input.publicConfig };
        const changed =
          !existing ||
          existing.provider !== provider ||
          fingerprintConfig(existing.provider, existing.publicConfig) !== fingerprintConfig(provider, publicConfig);

        const connection: Connection = {
          libraryId: this.libraryId,
          id: existing?.id ?? input.id ?? this.newId('conn'),
          provider,
          displayName: input.displayName ?? existing?.displayName ?? provider,
          publicConfig,
          credentialRef: existing?.credentialRef,
          // A version bump is what makes an old test result stale. It happens on
          // any meaningful change, never on a no-op save.
          configVersion: existing ? existing.configVersion + (changed ? 1 : 0) : 1,
          // Keeping a verification for an unchanged config is correct: re-saving
          // identical fields must not force the user to test again.
          verification: existing?.verification
        };
        this.assertValid(CONNECTIONS, connection);
        store.put(connection);

        // Bindings the caller asked for. Created disabled; never started here.
        const created: PurposeBinding[] = [];
        for (const purpose of input.purposes ?? []) {
          const bindingId = `${connection.id}:${purpose}`;
          const existingBinding = (await requestToPromise(
            ctx.store(BINDINGS).get([this.libraryId, bindingId])
          )) as PurposeBinding | undefined;
          if (existingBinding) {
            // §7.2: "不能把修改一半的草稿提交给定时任务". When the configuration
            // changed, the existing binding is *paused* — not silently re-pointed
            // at the new target. Re-pointing would let a scheduled task start
            // writing to an address the user never approved for it. The binding
            // keeps its old configVersion, so enabling it again requires a
            // verification of the current version (see `setPurposeEnabled`).
            const updated: PurposeBinding = {
              ...existingBinding,
              connectionId: connection.id,
              enabled: changed ? false : existingBinding.enabled,
              configVersion: changed ? existingBinding.configVersion : connection.configVersion
            };
            this.assertValid(BINDINGS, updated);
            ctx.store(BINDINGS).put(updated);
            continue;
          }
          const binding: PurposeBinding = {
            libraryId: this.libraryId,
            id: bindingId,
            purpose,
            connectionId: connection.id,
            enabled: false,
            options: {},
            configVersion: connection.configVersion
          };
          this.assertValid(BINDINGS, binding);
          ctx.store(BINDINGS).put(binding);
          created.push(binding);
        }

        return { connection, versionBumped: Boolean(existing && changed) };
      });
      return ok(result.value);
    } catch (err) {
      return fail(toAppError(err, '无法保存连接'));
    }
  }

  /**
   * Store a secret for a connection.
   *
   * Requires the master password: the envelope is encrypted here with the audited
   * Web Crypto path (§10.3 reuses the existing implementation rather than
   * inventing one). The plaintext never reaches storage, and the call fails with
   * `LOCKED` when the vault is locked instead of falling back to plain text.
   */
  async saveCredential(connectionId: string, secret: string, masterPassword: string): Promise<Result<{ credentialId: string }>> {
    if (!masterPassword) {
      return fail(
        appError('LOCKED', '金库已锁定，无法保存密钥。请先解锁再保存；应用不会把密钥以明文存储。', {
          suggestedAction: 'unlock_vault'
        })
      );
    }
    if (!secret) {
      return fail(appError('VALIDATION', '密钥为空。', { safeDetail: 'empty secret' }));
    }
    try {
      const connection = await this.getConnection(connectionId);
      if (!connection.ok) return fail(connection.error);
      if (!connection.value) {
        return fail(appError('NOT_FOUND', '这个连接不存在。', { safeDetail: connectionId }));
      }

      const encrypted = await encryptText(secret, masterPassword);
      const credentialId = `${connectionId}:credential`;

      await runV3Transaction([CREDENTIALS, CONNECTIONS], 'readwrite', async (ctx) => {
        const credential: ConnectionCredential = {
          libraryId: this.libraryId,
          id: credentialId,
          encryptedEnvelope: encrypted.ciphertext,
          iv: encrypted.iv,
          salt: encrypted.salt,
          keyMode: 'master',
          cryptoVersion: 1,
          updatedAt: this.now()
        };
        this.assertValid(CREDENTIALS, credential);
        ctx.store(CREDENTIALS).put(credential);

        const updated: Connection = { ...connection.value!, credentialRef: credentialId };
        this.assertValid(CONNECTIONS, updated);
        ctx.store(CONNECTIONS).put(updated);
      });

      return ok({ credentialId });
    } catch (err) {
      return fail(toAppError(err, '无法保存密钥'));
    }
  }

  /** True when this connection has a stored credential envelope. */
  async hasCredential(connectionId: string): Promise<Result<boolean>> {
    try {
      const row = await runV3Transaction([CREDENTIALS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(CREDENTIALS).get([this.libraryId, `${connectionId}:credential`]))
      );
      return ok(Boolean(row.value));
    } catch (err) {
      return fail(toAppError(err, '无法读取密钥状态'));
    }
  }

  /** Decrypt only inside an explicit unlock context; never returns it anywhere else. */
  async revealCredential(connectionId: string, masterPassword: string): Promise<Result<string>> {
    if (!masterPassword) {
      return fail(appError('LOCKED', '金库已锁定。', { suggestedAction: 'unlock_vault' }));
    }
    try {
      const row = await runV3Transaction([CREDENTIALS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(CREDENTIALS).get([this.libraryId, `${connectionId}:credential`]))
      );
      const credential = row.value as ConnectionCredential | undefined;
      if (!credential) {
        return fail(appError('NOT_FOUND', '这个连接还没有保存密钥。', { safeDetail: connectionId }));
      }
      const plain = await decryptText(credential.encryptedEnvelope, credential.iv, credential.salt, masterPassword);
      return ok(plain);
    } catch {
      // A wrong password must not leak whether the envelope or the password was
      // the problem, and must not be retried automatically.
      return fail(appError('AUTH_FAILED', '无法解密，请确认主密码正确。', { safeDetail: 'decrypt failed' }));
    }
  }

  /**
   * Record a test result for the connection's *current* version.
   *
   * Rejected when the caller tested an older version: §8.2 requires the report to
   * be bound to the configuration that was probed.
   */
  async recordVerification(
    connectionId: string,
    report: { ok: boolean; message: string; fingerprint: string; capabilities?: string[]; environment?: 'web' | 'extension'; configVersion: number }
  ): Promise<Result<{ accepted: boolean; reason?: string }>> {
    try {
      const current = await this.getConnection(connectionId);
      if (!current.ok) return fail(current.error);
      if (!current.value) return fail(appError('NOT_FOUND', '这个连接不存在。', { safeDetail: connectionId }));

      if (report.configVersion !== current.value.configVersion) {
        return ok({ accepted: false, reason: 'stale-report' });
      }

      const updated: Connection = {
        ...current.value,
        verification: {
          at: this.now(),
          ok: report.ok,
          message: report.message,
          fingerprint: report.fingerprint,
          configVersion: report.configVersion,
          capabilities: report.capabilities,
          environment: report.environment
        }
      };
      await runV3Transaction([CONNECTIONS], 'readwrite', async (ctx) => {
        this.assertValid(CONNECTIONS, updated);
        ctx.store(CONNECTIONS).put(updated);
      });
      return ok({ accepted: true });
    } catch (err) {
      return fail(toAppError(err, '无法记录检测结果'));
    }
  }

  async listBindings(connectionId?: string): Promise<Result<PurposeBinding[]>> {
    try {
      const rows = await runV3Transaction([BINDINGS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(BINDINGS).getAll() as IDBRequest<PurposeBinding[]>)
      );
      return ok(
        rows.value.filter(
          (row) => row.libraryId === this.libraryId && (!connectionId || row.connectionId === connectionId)
        )
      );
    } catch (err) {
      return fail(toAppError(err, '无法读取用途绑定'));
    }
  }

  /**
   * Enable or pause one purpose.
   *
   * Enabling requires a verification of the *current* configuration. That one rule
   * keeps three failure modes out at once: a task cannot start against a changed
   * target, cannot start against an untested connection, and cannot inherit a green
   * result from a configuration the user has since edited (§8.2).
   */
  async setPurposeEnabled(connectionId: string, purpose: PurposeId, enabled: boolean): Promise<Result<{ binding: PurposeBinding }>> {
    try {
      const current = await this.getConnection(connectionId);
      if (!current.ok) return fail(current.error);
      if (!current.value) return fail(appError('NOT_FOUND', '这个连接不存在。', { safeDetail: connectionId }));

      const bindingId = `${connectionId}:${purpose}`;
      const existing = await runV3Transaction([BINDINGS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(BINDINGS).get([this.libraryId, bindingId]))
      );
      if (!existing.value) {
        return fail(appError('NOT_FOUND', '这个用途还没有绑定到该连接。', { safeDetail: bindingId }));
      }
      const binding = existing.value as PurposeBinding;

      if (enabled) {
        const verification = current.value.verification;
        const verifiedCurrent =
          Boolean(verification?.ok) && verification?.configVersion === current.value.configVersion;
        if (!verifiedCurrent) {
          const stale = binding.configVersion !== current.value.configVersion;
          return fail(
            appError(
              'VALIDATION',
              stale
                ? '连接配置在绑定之后改动过。请重新测试当前配置，通过后再启用这个用途。'
                : '这个连接还没有测试通过，先测试再启用用途。',
              {
                safeDetail: `binding v${binding.configVersion} / connection v${current.value.configVersion} / verified v${verification?.configVersion ?? 'none'}`,
                suggestedAction: 'retest_connection'
              }
            )
          );
        }
        // Enabling also advances the binding to the version that was verified, so
        // the binding and the connection cannot drift apart silently.
        const updated: PurposeBinding = { ...binding, enabled: true, configVersion: current.value.configVersion };
        await runV3Transaction([BINDINGS], 'readwrite', async (ctx) => {
          this.assertValid(BINDINGS, updated);
          ctx.store(BINDINGS).put(updated);
        });
        return ok({ binding: updated });
      }

      const updated: PurposeBinding = { ...binding, enabled: false };
      await runV3Transaction([BINDINGS], 'readwrite', async (ctx) => {
        this.assertValid(BINDINGS, updated);
        ctx.store(BINDINGS).put(updated);
      });
      return ok({ binding: updated });
    } catch (err) {
      return fail(toAppError(err, '无法更新用途状态'));
    }
  }

  /**
   * What deleting this connection would affect.
   *
   * §8.3: "删除操作先列出用途，默认只暂停与断开；不删除远端数据". This is the
   * preview step; it writes nothing and makes no network call.
   */
  async previewDeleteConnection(connectionId: string): Promise<Result<DeleteConnectionPreview>> {
    try {
      const current = await this.getConnection(connectionId);
      if (!current.ok) return fail(current.error);
      if (!current.value) return fail(appError('NOT_FOUND', '这个连接不存在。', { safeDetail: connectionId }));

      const bindings = await this.listBindings(connectionId);
      if (!bindings.ok) return fail(bindings.error);

      // Items that keep a reference to this connection (e.g. remote documents).
      const items = await runV3Transaction([ITEMS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(ITEMS).getAll() as IDBRequest<Array<{ libraryId: string; projectIds?: string[] }>>)
      );
      const referencingProjects = new Set<string>();
      for (const item of items.value) {
        if (item.libraryId !== this.libraryId) continue;
        for (const projectId of item.projectIds || []) referencingProjects.add(projectId);
      }

      return ok({
        connection: current.value,
        affectedPurposes: bindings.value.map((b) => ({ purpose: b.purpose, bindingId: b.id, enabled: b.enabled })),
        referencingProjects: referencingProjects.size,
        deletesRemoteData: false
      });
    } catch (err) {
      return fail(toAppError(err, '无法预览删除影响'));
    }
  }

  /**
   * Delete a connection.
   *
   * Disables its purpose bindings in the same commit and leaves remote business
   * data alone (nothing here touches the network). `force` is not offered: the
   * preview exists so the caller has to state what it is doing.
   */
  async deleteConnection(connectionId: string): Promise<Result<DeleteConnectionResult>> {
    try {
      const preview = await this.previewDeleteConnection(connectionId);
      if (!preview.ok) return fail(preview.error);

      const disabled = preview.value.affectedPurposes;
      await runV3Transaction([CONNECTIONS, CREDENTIALS, BINDINGS], 'readwrite', async (ctx) => {
        const connectionStore = ctx.store(CONNECTIONS);
        const existing = (await requestToPromise(
          connectionStore.get([this.libraryId, connectionId])
        )) as Connection | undefined;
        if (!existing) throw new NotFoundError(`连接不存在: ${connectionId}`);
        connectionStore.delete([this.libraryId, connectionId]);
        ctx.store(CREDENTIALS).delete([this.libraryId, `${connectionId}:credential`]);

        const bindingStore = ctx.store(BINDINGS);
        for (const binding of disabled) {
          const row = (await requestToPromise(bindingStore.get([this.libraryId, binding.bindingId]))) as
            | PurposeBinding
            | undefined;
          if (!row) continue;
          bindingStore.put({ ...row, enabled: false });
        }
      });

      return ok({ deleted: true, disabledPurposes: disabled });
    } catch (err) {
      return fail(err instanceof NotFoundError ? toAppError(err) : toAppError(err, '无法删除连接'));
    }
  }

  /**
   * Jobs parked because the vault is locked.
   *
   * Reading them is enough for P2-03: the state is created by `evaluateReadiness`
   * and persisted by the job layer in P2-05. Keeping a read here lets the settings
   * page say "N 个任务在等解锁" without pretending the queue already exists.
   */
  async countWaitingUnlock(): Promise<Result<number>> {
    try {
      const rows = await runV3Transaction([JOBS], 'readonly', async (ctx) =>
        requestToPromise(ctx.store(JOBS).getAll() as IDBRequest<Array<{ libraryId: string; state: string }>>)
      );
      return ok(
        rows.value.filter((row) => row.libraryId === this.libraryId && row.state === 'waiting-unlock').length
      );
    } catch (err) {
      return fail(toAppError(err, '无法读取等待解锁的任务'));
    }
  }
}
