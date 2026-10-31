/**
 * Switching this device onto the v3 library — the orchestration, kept out of `App.tsx`.
 * Two reasons, one of them a measured build fact:
 * 1. `App.tsx` is the entry chunk. When the entry itself does `await import('…/migration/runner')`,
 */
import type { MigrationReport } from '../../repositories/migration/types';

export interface SwitchToV3Result {
  ok: boolean;
  error?: string;
  /** Library the app must read after a successful switch. */
  libraryId?: string;
  report?: Pick<MigrationReport, 'stagingLibraryId' | 'counts' | 'warnings' | 'unknownFields'>;
  snapshotHash?: string;
}

/**
 * Run the verified v2 → v3 migration and switch `activeLibraryId` in one step.
 *
 * `preferPayload` matters for this caller: the payload is the app's current fact source and
 * the IndexedDB mirror is a copy of it, so migrating both would put every record into the
 * switched library twice. The mirror is still used to fill collections the payload lacks.
 */
export async function runMigrationAndSwitch(password: string): Promise<SwitchToV3Result> {
  if (!password) {
    return { ok: false, error: '迁移前需要一份加密快照，请先输入备份密码。' };
  }
  try {
    const { migrateV2ToV3, readActiveLibraryId } = await import('../../repositories/migration/runner');
    const outcome = await migrateV2ToV3({ password, allowSwitch: true, preferPayload: true });
    if (!outcome.ok || !outcome.switched) {
      const counts = outcome.report.counts
        .slice(0, 4)
        .map((entry) => `${entry.store} ${entry.written}/${entry.read}`)
        .join(' / ');
      const reason =
        outcome.report.failure ?? outcome.error ?? (outcome.switched ? '' : '校验未通过，未切换读取来源');
      return {
        ok: false,
        error: `迁移未完成（本机数据未改动）：${reason}${counts ? ` · 已计划 ${counts}` : ''}`
      };
    }
    return {
      ok: true,
      libraryId: (await readActiveLibraryId()) ?? undefined,
      report: {
        stagingLibraryId: outcome.report.stagingLibraryId,
        counts: outcome.report.counts,
        warnings: outcome.report.warnings,
        unknownFields: outcome.report.unknownFields
      },
      snapshotHash: outcome.snapshotHash
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** The library the app should read, if a migration has ever switched this device. */
export async function readActiveLibrary(): Promise<string | null> {
  const { readActiveLibraryId } = await import('../../repositories/migration/runner');
  return readActiveLibraryId();
}
