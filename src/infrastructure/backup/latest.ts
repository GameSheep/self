/**
 * Per-device "latest" pointer (P2-05).
 *
 * §10.2 asks for two things that sound contradictory until you separate them:
 * "每次备份使用不可变 generation 目录，不覆盖其他设备快照" **and** "设备拥有独立
 * latest 指针". The generation directories stay immutable; the pointer is a tiny
 * mutable object *per device* that says which generation that device considers
 * current. Two devices backing up to one prefix therefore never race over a shared
 * `state.json` — the old design's central flaw.
 *
 * Two rules make the pointer safe to trust:
 *
 * 1. **It is written after the completion marker and after verification.** A
 *    pointer can therefore never name a generation that was not proven complete.
 * 2. **It is verified on read.** The pointer carries the manifest hash, and
 *    `resolveLatestGeneration` re-checks that the named generation still has a
 *    matching marker. If it does not, the pointer is reported as stale and the
 *    caller falls back to scanning — a broken pointer degrades to a slower path,
 *    never to a wrong restore source.
 */
import { toAppError } from '../../repositories/errors';
import { COMPLETION_NAME, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, devicePrefix, generationPrefix, type CompletionMarker } from './format';
import type { BackupTransport } from './transport';

export const LATEST_NAME = 'latest.json';

export interface LatestPointer {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  libraryId: string;
  deviceId: string;
  generationId: string;
  /** Hash of the generation's stored manifest, so a replaced package is caught. */
  manifestHash: string;
  createdAt: number;
  writtenAt: number;
  objectCount: number;
  totalBytes: number;
}

export function latestPath(libraryId: string, deviceId: string): string {
  return `${devicePrefix(libraryId, deviceId)}${LATEST_NAME}`;
}

export async function writeLatestPointer(transport: BackupTransport, pointer: LatestPointer): Promise<void> {
  await transport.put(latestPath(pointer.libraryId, pointer.deviceId), JSON.stringify(pointer), 'application/json');
}

export type LatestRead =
  | { ok: true; pointer: LatestPointer }
  | { ok: false; reason: string };

/** Read and structurally check the pointer (does not touch the generation yet). */
export async function readLatestPointer(
  transport: BackupTransport,
  libraryId: string,
  deviceId: string
): Promise<LatestRead> {
  try {
    const raw = await transport.get(latestPath(libraryId, deviceId));
    if (raw === null) return { ok: false, reason: '还没有本设备的备份指针' };
    const pointer = JSON.parse(raw) as LatestPointer;
    if (pointer.format !== BACKUP_FORMAT) return { ok: false, reason: '备份指针格式不正确' };
    if (Number(pointer.formatVersion) !== BACKUP_FORMAT_VERSION) return { ok: false, reason: '备份指针版本不支持' };
    if (pointer.libraryId !== libraryId || pointer.deviceId !== deviceId) {
      return { ok: false, reason: '备份指针不属于本设备' };
    }
    if (!pointer.generationId) return { ok: false, reason: '备份指针缺少批次标识' };
    return { ok: true, pointer };
  } catch (err) {
    const error = toAppError(err, '读取备份指针失败');
    return { ok: false, reason: error.userMessage };
  }
}

export interface ResolvedLatest {
  /** `pointer` = the device pointer was valid; `scan` = fell back to a listing. */
  source: 'pointer' | 'scan' | 'none';
  generationId?: string;
  manifestHash?: string;
  createdAt?: number;
  /** Present when a pointer existed but could not be trusted. */
  staleReason?: string;
}

/**
 * Check that a pointer still names a complete, unchanged generation.
 *
 * Returning a reason instead of throwing is deliberate: a stale pointer is a
 * normal, recoverable situation (someone cleaned the directory, or a device was
 * restored from elsewhere), and the caller must degrade to a scan rather than fail.
 */
export async function verifyPointerTarget(
  transport: BackupTransport,
  pointer: LatestPointer
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const markerRaw = await transport.get(
      `${generationPrefix(pointer.libraryId, pointer.deviceId, pointer.generationId)}${COMPLETION_NAME}`
    );
    if (markerRaw === null) return { ok: false, reason: '备份指针指向的批次缺少完成标记' };
    const marker = JSON.parse(markerRaw) as CompletionMarker;
    if (marker.manifestHash !== pointer.manifestHash) return { ok: false, reason: '备份指针与批次清单不一致' };
    if (marker.generationId !== pointer.generationId) return { ok: false, reason: '备份指针与批次标识不一致' };
    return { ok: true };
  } catch (err) {
    const error = toAppError(err, '校验备份指针失败');
    return { ok: false, reason: error.userMessage };
  }
}

/** Human summary for the settings page: what will be restored by default. */
export function describeResolvedLatest(resolved: ResolvedLatest): string {
  if (resolved.source === 'none') {
    return resolved.staleReason ? `没有可恢复的备份（${resolved.staleReason}）` : '还没有可恢复的备份';
  }
  const when = resolved.createdAt ? new Date(resolved.createdAt).toLocaleString() : '时间未知';
  const via = resolved.source === 'pointer' ? '' : '（本设备指针不可用，已改用最新的完整批次）';
  return `${resolved.generationId}　${when}${via}`;
}
