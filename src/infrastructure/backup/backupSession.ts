/**
 * Backup password session (P2-05).
 * §10.3 is explicit about the boundary: "备份密码独立于连接密钥，需用户建立并保管；
 * 自动运行只能使用当前已解锁会话或用户明确授权的本机受信任包装密钥。缺少密钥时等
 * · 待解锁，不能降级明文上传."
 */
const META_KEY = 'selfhub_backup_password_meta';

export interface BackupPasswordMeta {
  /** When the user last established a backup password on this device. */
  establishedAt: number;
}

let sessionPassword: string | null = null;

export function readBackupPasswordMeta(): BackupPasswordMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BackupPasswordMeta;
    return typeof parsed?.establishedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function writeBackupPasswordMeta(meta: BackupPasswordMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* a failed hint write must never block a backup the user asked for */
  }
}

export function markBackupPasswordEstablished(at = Date.now()): void {
  writeBackupPasswordMeta({ establishedAt: at });
}

/** True when a password has ever been set here (the password itself is unknown). */
export function isBackupPasswordEstablished(): boolean {
  return readBackupPasswordMeta() !== null;
}

/** Set (or clear, with an empty value) the password for this page session. */
export function setSessionBackupPassword(password: string | null | undefined): void {
  const trimmed = (password ?? '').trim();
  sessionPassword = trimmed ? trimmed : null;
  if (sessionPassword) markBackupPasswordEstablished();
}

export function getSessionBackupPassword(): string | null {
  return sessionPassword;
}

export function hasSessionBackupPassword(): boolean {
  return sessionPassword !== null;
}

/**
 * Drop the in-memory password.
 *
 * Called on an explicit lock and on the app's own lock action, mirroring the vault:
 * locking must clear decryption material, and the backup password is decryption
 * material for the packages this device wrote.
 */
export function clearSessionBackupPassword(): void {
  sessionPassword = null;
}
