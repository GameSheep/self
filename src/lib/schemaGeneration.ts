/**
 * Write-generation guard (P0-03).
 * The P2 migration will move the local fact source from a single `localStorage`
 * blob (schema v2) to versioned transaction stores (schema v3). The dangerous
 * · every writer must pass. From P1 onward a client that only understands
 */

/** Payload generation this build can read and write. */
export const CURRENT_GENERATION = 2;

/**
 * Highest generation this build understands at all. A higher active generation
 * means "a newer client already upgraded this origin" — we go read-only instead
 * of overwriting it.
 */
export const MAX_SUPPORTED_GENERATION = 2;

export const SCHEMA_GENERATION_KEY = 'self_hub_schema_generation';

/** Identifies the writer for diagnostics; not used for authorisation. */
export const SCHEMA_WRITER = 'self-hub-web@p1';

export interface GenerationMarker {
  generation: number;
  writer: string;
  claimedAt: number;
}

export type WriteMode = 'writable' | 'read-only-newer-schema' | 'unavailable';

export interface WriteCheck {
  mode: WriteMode;
  /** Generation recorded on this origin (CURRENT_GENERATION when unset). */
  activeGeneration: number;
  supportedGeneration: number;
  /** User-facing explanation; empty when `mode === 'writable'`. */
  message: string;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parseMarker(raw: string | null): GenerationMarker | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GenerationMarker>;
    const generation = Number(parsed?.generation);
    if (!Number.isFinite(generation) || generation <= 0) return null;
    return {
      generation,
      writer: typeof parsed.writer === 'string' ? parsed.writer : 'unknown',
      claimedAt: Number(parsed.claimedAt) || 0
    };
  } catch {
    return null;
  }
}

/** The recorded marker, or null when this origin has never been claimed. */
export function readGenerationMarker(): GenerationMarker | null {
  return parseMarker(safeGet(SCHEMA_GENERATION_KEY));
}

/** Effective generation for read decisions; an unclaimed origin is current. */
export function activeGeneration(): number {
  return readGenerationMarker()?.generation ?? CURRENT_GENERATION;
}

/**
 * Record the generation this client is about to write.
 *
 * Never downgrades: if a newer generation is already registered, the marker is
 * left alone so the newer client keeps ownership. Returns what is in effect.
 */
export function claimGeneration(writer: string = SCHEMA_WRITER): GenerationMarker {
  const existing = readGenerationMarker();
  if (existing && existing.generation > CURRENT_GENERATION) return existing;
  if (existing && existing.generation === CURRENT_GENERATION && existing.writer === writer) {
    return existing;
  }
  const marker: GenerationMarker = { generation: CURRENT_GENERATION, writer, claimedAt: Date.now() };
  safeSet(SCHEMA_GENERATION_KEY, JSON.stringify(marker));
  return marker;
}

/**
 * Decide whether this client may write.
 *
 * - `unavailable`: `localStorage` itself is unusable (private mode, blocked
 *   cookies). Callers keep their existing in-memory fallback behaviour.
 * - `read-only-newer-schema`: another client already upgraded this origin.
 * - `writable`: safe.
 */
export function checkWritable(): WriteCheck {
  if (typeof localStorage === 'undefined') {
    return {
      mode: 'unavailable',
      activeGeneration: CURRENT_GENERATION,
      supportedGeneration: MAX_SUPPORTED_GENERATION,
      message: '当前环境没有可用的本地存储'
    };
  }
  // A throwing setItem means the storage is blocked; keep the caller's fallback.
  const probeKey = '__selfhub_gen_probe';
  try {
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
  } catch {
    return {
      mode: 'unavailable',
      activeGeneration: CURRENT_GENERATION,
      supportedGeneration: MAX_SUPPORTED_GENERATION,
      message: '浏览器本地存储当前不可写'
    };
  }

  const marker = readGenerationMarker();
  const active = marker?.generation ?? CURRENT_GENERATION;
  if (active > MAX_SUPPORTED_GENERATION) {
    return {
      mode: 'read-only-newer-schema',
      activeGeneration: active,
      supportedGeneration: MAX_SUPPORTED_GENERATION,
      message:
        `本机数据已由更新版本升级到第 ${active} 代格式，当前页面只识别到第 ${MAX_SUPPORTED_GENERATION} 代。` +
        '为避免覆盖新数据，本页已切换为只读：请关闭本页并重新打开最新版本，或先导出备份。'
    };
  }
  return {
    mode: 'writable',
    activeGeneration: active,
    supportedGeneration: MAX_SUPPORTED_GENERATION,
    message: ''
  };
}

/** Convenience wrapper: no message when writable, otherwise the reason. */
export function assertWritable(): { ok: true } | { ok: false; reason: string; check: WriteCheck } {
  const check = checkWritable();
  if (check.mode === 'writable') return { ok: true };
  // `unavailable` is not a schema conflict: the caller has its own fallback
  // (in-memory buffer + surfaced error) and must still be allowed to try.
  if (check.mode === 'unavailable') return { ok: true };
  return { ok: false, reason: check.message, check };
}
