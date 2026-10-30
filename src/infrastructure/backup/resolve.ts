/**
 * "Which generation is current?" (P2-05).
 *
 * Lives apart from both `latest.ts` (pointer primitives) and `writer.ts` (write /
 * read / retention) so neither has to import the other — the pointer asks the
 * writer for a scan fallback, and the writer updates the pointer.
 *
 * The rule the caller depends on: **the default restore source is never an
 * unmarked generation** (§10.2). A pointer that cannot be verified degrades to the
 * newest *complete* generation, and the degradation is reported rather than hidden.
 */
import { fail, ok, type Result } from '../../repositories/errors';
import { listGenerations } from './writer';
import { readLatestPointer, verifyPointerTarget, type ResolvedLatest } from './latest';
import type { BackupTransport } from './transport';

export interface ResolveLatestOptions {
  transport: BackupTransport;
  libraryId: string;
  deviceId: string;
  /** Without a password only marker facts are available for the scan fallback. */
  password?: string;
}

export async function resolveLatestGeneration(options: ResolveLatestOptions): Promise<Result<ResolvedLatest>> {
  const { transport, libraryId, deviceId } = options;

  const pointerRead = await readLatestPointer(transport, libraryId, deviceId);
  let staleReason: string | undefined;
  if (pointerRead.ok) {
    const verified = await verifyPointerTarget(transport, pointerRead.pointer);
    if (verified.ok) {
      return ok({
        source: 'pointer',
        generationId: pointerRead.pointer.generationId,
        manifestHash: pointerRead.pointer.manifestHash,
        createdAt: pointerRead.pointer.createdAt
      });
    }
    staleReason = verified.reason;
  } else {
    staleReason = pointerRead.reason;
  }

  const listed = await listGenerations({ transport, libraryId, deviceId, password: options.password });
  if (!listed.ok) return fail(listed.error);
  const newest = listed.value.find((entry) => entry.complete);
  if (!newest) return ok({ source: 'none', staleReason });
  return ok({
    source: 'scan',
    generationId: newest.generationId,
    createdAt: newest.createdAt ?? newest.writtenAt,
    staleReason
  });
}
