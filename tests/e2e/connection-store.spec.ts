import { test, expect } from '@playwright/test';
import { resetApp } from './helpers';

/**
 * P2-03: connections, credentials and purposes stored as three separate facts.
 *
 * The properties asserted here are the ones the redesign promises in prose:
 *  - saving a connection does not enable any purpose,
 *  - editing the configuration invalidates a previous green test result,
 *  - a secret cannot be stored while the vault is locked, and is never stored in
 *    plain text once it is stored,
 *  - deleting a connection reports the purposes it affects and disables them,
 *    without touching remote business data,
 *  - a binding whose configuration changed cannot be enabled until it is redone,
 *  - and a locked vault parks work as `waiting-unlock` rather than failing it.
 *
 * Everything runs in the browser through the dev-only bridge, because the point
 * is what actually reaches IndexedDB — not what a mocked repository returns.
 */

const LIB = 'p2-03-library';
const MASTER = 'correct horse battery staple';

/**
 * Run a scenario against a connection repository for {@link LIB}.
 *
 * `scenario` is serialised and re-created in the page, so it must only use its
 * two arguments (`b` = bridge, `args` = everything from the Node side). Nothing
 * from this file's scope is available inside it — that is why every constant is
 * passed through `args` instead of being closed over.
 */
async function scenario<T>(
  page: import('@playwright/test').Page,
  args: Record<string, unknown>,
  fn: (b: any, args: any) => Promise<T>
): Promise<T> {
  return page.evaluate(
    async ({ lib, source, passed }) => {
      const b = window.__selfhubContract!.connections(lib as string);
      // eslint-disable-next-line no-new-func
      const run = new Function('b', 'args', `return (${source})(b, args);`);
      return await run(b, passed);
    },
    { lib: LIB, source: fn.toString(), passed: args }
  ) as Promise<T>;
}

test.describe('P2-03 连接、凭据与用途', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
  });

  test('保存连接不会启用任何用途，用途是独立的第二次决定', async ({ page }) => {
    await resetApp(page);

    const result = await scenario(page, {}, async (b) => {
      const saved = await b.save({
        id: 'conn-webdav',
        provider: 'webdav',
        publicConfig: { url: 'https://dav.example.invalid/', username: 'someone' },
        purposes: ['backup']
      });
      const bindings = await b.bindings('conn-webdav');
      return { saved, bindings };
    });

    expect(result.saved.ok).toBe(true);
    expect(result.saved.connection?.configVersion).toBe(1);
    // The binding exists but is off: filling fields must never start a task.
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0].purpose).toBe('backup');
    expect(result.bindings[0].enabled).toBe(false);
  });

  test('改动配置会让已通过的检测结果立即过期', async ({ page }) => {
    await resetApp(page);

    const result = await scenario(page, {}, async (b) => {
      await b.save({
        id: 'conn-oss',
        provider: 'oss',
        publicConfig: { bucket: 'my-bucket', endpoint: 'oss-cn-hangzhou.aliyuncs.com' }
      });
      await b.recordVerification('conn-oss', {
        ok: true,
        message: '已验证：可列出对象',
        fingerprint: b.fingerprint('oss', { bucket: 'my-bucket', endpoint: 'oss-cn-hangzhou.aliyuncs.com' }),
        configVersion: 1
      });
      const verified = await b.status('conn-oss');

      // Edit the endpoint: same provider, different config.
      const edited = await b.save({
        id: 'conn-oss',
        provider: 'oss',
        publicConfig: { bucket: 'my-bucket', endpoint: 'oss-cn-beijing.aliyuncs.com' }
      });
      const afterEdit = await b.status('conn-oss');

      // Re-saving identical fields must not force a re-test.
      const noop = await b.save({
        id: 'conn-oss',
        provider: 'oss',
        publicConfig: { bucket: 'my-bucket', endpoint: 'oss-cn-beijing.aliyuncs.com' }
      });
      const afterNoop = await b.status('conn-oss');

      return { verified, edited, afterEdit, noop, afterNoop };
    });

    expect(result.verified?.stage).toBe('verified');
    expect(result.edited.versionBumped).toBe(true);
    expect(result.afterEdit?.stage).toBe('stale');
    expect(result.afterEdit?.label).toContain('过期');
    expect(result.noop.versionBumped).toBe(false);
    expect(result.afterNoop?.stage).toBe('stale');
  });

  test('金库锁定时拒绝保存密钥，绝不退化成明文', async ({ page }) => {
    await resetApp(page);

    const result = await scenario(page, { master: MASTER }, async (b, args) => {
      await b.save({ id: 'conn-ai', provider: 'ai', publicConfig: { provider: 'deepseek', model: 'deepseek-chat' } });
      const locked = await b.saveCredential('conn-ai', 'sk-secret-value', '');
      const hasAfterLocked = await b.hasCredential('conn-ai');
      const saved = await b.saveCredential('conn-ai', 'sk-secret-value', args.master);
      const hasAfterSaved = await b.hasCredential('conn-ai');
      return { locked, hasAfterLocked, saved, hasAfterSaved };
    });

    expect(result.locked.ok).toBe(false);
    expect(result.locked.error?.code).toBe('LOCKED');
    // Nothing was written while locked.
    expect(result.hasAfterLocked.value).toBe(false);

    expect(result.saved.ok).toBe(true);
    expect(result.hasAfterSaved.value).toBe(true);
  });

  test('存储的密钥是密文：库里找不到明文，只有主密码能解回', async ({ page }) => {
    await resetApp(page);

    const plaintext = 'sk-live-plaintext-must-not-appear';

    const result = await scenario(page, { master: MASTER, plaintext }, async (b, args) => {
      await b.save({ id: 'conn-ai2', provider: 'ai', publicConfig: { provider: 'deepseek', model: 'deepseek-chat' } });
      await b.saveCredential('conn-ai2', args.plaintext, args.master);

      // Read the raw store in a fresh transaction to prove what is on disk,
      // rather than trusting the repository's own read path. No version is pinned: opening
      // at a hardcoded version fails the moment the schema legitimately moves on (the v3
      // schema bumped to 3 when the migration snapshot store was added).
      const raw = await new Promise<string>((resolve) => {
        const request = indexedDB.open('self_hub_idb');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('connection_credentials_v3', 'readonly');
          const getAll = tx.objectStore('connection_credentials_v3').getAll();
          getAll.onsuccess = () => {
            resolve(JSON.stringify(getAll.result));
            db.close();
          };
          getAll.onerror = () => {
            resolve('ERR');
            db.close();
          };
        };
        request.onerror = () => resolve('ERR');
      });

      const wrong = await b.reveal('conn-ai2', 'wrong password');
      const right = await b.reveal('conn-ai2', args.master);
      return { raw, wrong, right };
    });

    // The ciphertext store must not contain the plaintext anywhere.
    expect(result.raw).not.toContain(plaintext);
    expect(result.raw).toContain('encryptedEnvelope');

    expect(result.wrong.ok).toBe(false);
    expect(result.wrong.error?.code).toBe('AUTH_FAILED');
    expect(result.right.ok).toBe(true);
    expect(result.right.value).toBe(plaintext);
  });

  test('删除连接先列出受影响用途，删除时只暂停用途、不碰远端数据', async ({ page }) => {
    await resetApp(page);

    const result = await scenario(page, {}, async (b) => {
      await b.save({
        id: 'conn-del',
        provider: 'webdav',
        publicConfig: { url: 'https://dav.example.invalid/', username: 'u' },
        purposes: ['backup', 'remote-vault']
      });
      // Enabling requires a passing test at the current config version, which is
      // the same order the settings UI enforces.
      await b.recordVerification('conn-del', {
        ok: true,
        message: '已验证：可读写',
        fingerprint: b.fingerprint('webdav', { url: 'https://dav.example.invalid/', username: 'u' }),
        configVersion: 1
      });
      await b.setPurpose('conn-del', 'backup', true);
      const preview = await b.previewDelete('conn-del');
      const removed = await b.remove('conn-del');
      const bindingsAfter = await b.bindings('conn-del');
      const statusAfter = await b.status('conn-del');
      return { preview, removed, bindingsAfter, statusAfter };
    });

    expect(result.preview.ok).toBe(true);
    // Both purposes are listed before anything is deleted.
    expect(result.preview.value!.affectedPurposes.map((p: { purpose: string }) => p.purpose).sort()).toEqual([
      'backup',
      'remote-vault'
    ]);
    expect(
      result.preview.value!.affectedPurposes.find((p: { purpose: string }) => p.purpose === 'backup')!.enabled
    ).toBe(true);
    // The preview states plainly that remote data is not part of the operation.
    expect(result.preview.value!.deletesRemoteData).toBe(false);

    expect(result.removed.ok).toBe(true);
    expect(result.removed.value!.deleted).toBe(true);
    expect(result.removed.value!.disabledPurposes).toBe(2);

    // Bindings survive as disabled rather than vanishing, so the user can see
    // what used to point at this connection.
    expect(result.bindingsAfter.every((b: { enabled: boolean }) => b.enabled === false)).toBe(true);
    expect(result.statusAfter).toBeNull();
  });

  test('配置改动后不允许启用旧用途，必须先重新保存并测试', async ({ page }) => {
    await resetApp(page);

    const result = await scenario(page, {}, async (b) => {
      await b.save({
        id: 'conn-bind',
        provider: 'webdav',
        publicConfig: { url: 'https://dav.example.invalid/', username: 'u' },
        purposes: ['backup']
      });
      await b.recordVerification('conn-bind', {
        ok: true,
        message: '已验证：可读写',
        fingerprint: b.fingerprint('webdav', { url: 'https://dav.example.invalid/', username: 'u' }),
        configVersion: 1
      });
      const firstEnable = await b.setPurpose('conn-bind', 'backup', true);

      // Change the target: the binding now refers to an older configuration.
      await b.save({
        id: 'conn-bind',
        provider: 'webdav',
        publicConfig: { url: 'https://other.example.invalid/', username: 'u' },
        purposes: ['backup']
      });

      const enableAfterChange = await b.setPurpose('conn-bind', 'backup', true);
      return { firstEnable, enableAfterChange };
    });

    expect(result.firstEnable.ok).toBe(true);
    // Enabling against a stale binding is refused rather than silently pointed at
    // a target the user never approved.
    expect(result.enableAfterChange.ok).toBe(false);
    expect(result.enableAfterChange.error?.code).toBe('VALIDATION');
  });

  test('金库锁定时任务停在 waiting-unlock，而不是失败或假装成功', async ({ page }) => {
    await resetApp(page);

    const result = await scenario(page, { master: MASTER }, async (b, args) => {
      await b.save({
        id: 'conn-task',
        provider: 'webdav',
        publicConfig: { url: 'https://dav.example.invalid/', username: 'u' },
        purposes: ['backup']
      });
      await b.saveCredential('conn-task', 'app-password', args.master);
      await b.recordVerification('conn-task', {
        ok: true,
        message: '已验证：可读写',
        fingerprint: b.fingerprint('webdav', { url: 'https://dav.example.invalid/', username: 'u' }),
        configVersion: 1
      });
      await b.setPurpose('conn-task', 'backup', true);

      const unlocked = await b.readiness('conn-task', 'backup', true);
      const locked = await b.readiness('conn-task', 'backup', false);

      // Pausing the purpose is a different action from locking the vault.
      await b.setPurpose('conn-task', 'backup', false);
      const paused = await b.readiness('conn-task', 'backup', true);

      const waiting = await b.countWaitingUnlock();
      return { unlocked, locked, paused, waiting };
    });

    expect(result.unlocked).toBe('runnable');
    expect(result.locked).toBe('waiting-unlock');
    expect(result.paused).toBe('paused');
    // No job rows exist yet (the queue arrives in P2-05), so the count is zero
    // rather than a fabricated number.
    expect(result.waiting).toBe(0);
  });

  test('必填字段判定与指纹都不依赖密钥明文', async ({ page }) => {
    await resetApp(page);
    const result = await scenario(page, {}, async (b) => ({
      incomplete: b.requiredComplete('oss', { bucket: 'b' }),
      complete: b.requiredComplete('oss', { bucket: 'b', endpoint: 'e' }),
      same: b.fingerprint('oss', { bucket: 'b', endpoint: 'e' }),
      other: b.fingerprint('oss', { bucket: 'b', endpoint: 'e2' }),
      // Same values in a different insertion order must fingerprint identically.
      reordered: b.fingerprint('oss', { endpoint: 'e', bucket: 'b' })
    }));

    expect(result.incomplete).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.same).toBe(result.reordered);
    expect(result.other).not.toBe(result.same);
    // A short hex digest, not a value that could carry a secret.
    expect(result.same).toMatch(/^[0-9a-f]{8}$/);
  });
});
